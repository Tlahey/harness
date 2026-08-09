import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fromRoot, loadWorkspace, requireRole, resolveModel, type Workspace } from "../config/load.ts";
import { EventLog } from "../core/events.ts";
import { readBaseline, runEvaluation, type EvaluationResult } from "../core/evaluate.ts";
import { listMemories } from "../core/memory.ts";
import { loadManifest, type RunManifest } from "../core/orchestrator.ts";
import { runAgent } from "../opencode/exec.ts";
import { diffFiles, hasUncommittedChanges, isGitRepo, restoreFiles } from "../util/git.ts";
import { c, fail, log } from "../util/log.ts";

export interface ImproveArgs {
  /** Let the improver rewrite the role files instead of only writing a proposal. */
  apply?: boolean;
  /** Re-run the evals afterwards and roll back on regression. */
  evaluate?: boolean;
  /** How many past runs to feed it. */
  runs?: number;
  dryRun?: boolean;
  verbose?: boolean;
}

async function recentRuns(ws: Workspace, limit: number): Promise<RunManifest[]> {
  const dir = fromRoot(ws.root, ws.config.paths.artifacts);
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const manifests: RunManifest[] = [];
  for (const name of entries.sort().reverse().slice(0, limit)) {
    const manifest = await loadManifest(join(dir, name));
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

async function latestEvalResults(ws: Workspace): Promise<EvaluationResult[]> {
  const dir = fromRoot(ws.root, ".harness/evals");
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const byEval = new Map<string, EvaluationResult>();
  for (const name of entries.sort()) {
    const raw = await readFile(join(dir, name, "result.json"), "utf8").catch(() => null);
    if (!raw) continue;
    const result = JSON.parse(raw) as EvaluationResult;
    byEval.set(result.evaluation, result); // sorted ascending, so the last one wins
  }
  return [...byEval.values()];
}

/**
 * The evidence file. It is a file rather than a giant prompt so a human can read exactly
 * what the improver was told before it proposes anything.
 */
async function writeBriefing(ws: Workspace, dir: string, args: ImproveArgs): Promise<string> {
  const runs = await recentRuns(ws, args.runs ?? 10);
  const evals = await latestEvalResults(ws);
  const baseline = await readBaseline(ws);
  const memories = await listMemories(ws);

  const lines: string[] = [
    `# Improvement briefing — ${ws.config.project.name}`,
    "",
    `Generated at ${new Date().toISOString()}.`,
    "",
    "## Current roles",
    "",
  ];

  for (const role of ws.roles.values()) {
    lines.push(
      `- \`${ws.config.paths.roles.replace(/^\.\//, "")}/${role.name}.yaml\` — ${role.description} ` +
        `(model ${resolveModel(ws.config, role.model)}, mode ${role.mode})`,
    );
  }

  lines.push("", "## Recent runs", "");
  if (runs.length === 0) lines.push("_No runs recorded._");
  for (const run of runs) {
    const failedSteps = run.steps.filter((s) => s.status === "failed");
    const missing = run.steps.flatMap((s) => s.missingOutputs.map((m) => `${s.id}:${m}`));
    const retried = run.steps.filter((s) => s.attempts > 1);
    const loops = run.steps.filter((s) => s.iterations !== undefined);
    lines.push(
      `### ${run.runId} — ${run.status}`,
      "",
      `- pipeline: ${run.pipeline}`,
      `- inputs: ${JSON.stringify(run.inputs)}`,
      `- failed steps: ${failedSteps.map((s) => s.id).join(", ") || "none"}`,
      `- retries: ${retried.map((s) => `${s.id}×${s.attempts}`).join(", ") || "none"}`,
      `- missing deliverables: ${missing.join(", ") || "none"}`,
      `- loops: ${loops.map((s) => `${s.id}×${s.iterations}`).join(", ") || "none"}`,
      "",
    );
    for (const step of run.steps) {
      if (step.outputFile) lines.push(`- transcript ${step.id}: \`${step.outputFile}\``);
    }
    lines.push("");
  }

  lines.push("## Evaluations", "");
  if (evals.length === 0) {
    lines.push("_No eval has run. Without scores, every proposal below is a guess._");
  }
  for (const result of evals) {
    const known = baseline?.scores[result.evaluation];
    lines.push(
      `### ${result.evaluation} — ${Math.round(result.score * 100)}%` +
        (known === undefined ? "" : ` (baseline ${Math.round(known * 100)}%)`),
      "",
    );
    for (const assertion of result.assertions) {
      lines.push(`- ${assertion.passed ? "✓" : "✗"} ${assertion.label} — ${assertion.detail}`);
    }
    lines.push("");
  }

  lines.push("## Memory", "");
  if (memories.length === 0) lines.push("_Empty._");
  for (const memory of memories) {
    lines.push(`- \`${relative(ws.root, memory.file)}\` (${memory.type}) — ${memory.description}`);
  }
  lines.push("");

  const file = join(dir, "briefing.md");
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function buildPrompt(ws: Workspace, briefing: string, proposal: string, apply: boolean): string {
  const scope = ws.config.improve.scope.map((path) => `\`${path}\``).join(", ");
  const common = [
    `Read the briefing: ${briefing}`,
    "",
    "It contains the current roles, the recent runs (failures, retries, missing deliverables,",
    "loop iterations), the eval scores and the project memory.",
    "",
    "Your job: find what in the **role prompts** explains the failures observed — and only",
    "what the traces actually support. A hunch with no trace behind it is not an improvement,",
    "it is a random rewrite.",
    "",
    "For every change you propose: the trace that motivates it, the file, the exact edit, and",
    "how we will know it worked (which eval assertion should move).",
    "",
    `Allowed scope: ${scope}. Touch nothing else — not the application code, not the`,
    "pipelines, not the configuration.",
  ];

  if (!apply) {
    return [
      ...common,
      "",
      `Write your proposal to ${proposal}. Do not modify any other file: a human reviews it`,
      "before anything is applied.",
    ].join("\n");
  }

  return [
    ...common,
    "",
    `Apply your changes directly within ${scope}, then write to ${proposal} a report of what`,
    "you changed, why, and what to measure next.",
    "",
    "Keep the changes minimal and targeted. An added instruction should replace or sharpen an",
    "existing one, not pile onto it: a prompt that grows every run ends up ignored. If the",
    "traces support no change, change nothing and say so.",
  ].join("\n");
}

export async function improveCommand(args: ImproveArgs): Promise<number> {
  const ws = await loadWorkspace();
  const role = requireRole(ws, ws.config.improve.role);
  const scopePaths = ws.config.improve.scope;

  const baseline = await readBaseline(ws);
  if (ws.config.improve.requireBaseline && !baseline) {
    fail(
      "No eval baseline. Improving without a measurement is drift, not improvement:\n" +
        "  run `harness eval --save-baseline`, or set `improve.requireBaseline: false`.",
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(fromRoot(ws.root, ".harness/improve"), stamp);
  const briefing = await writeBriefing(ws, dir, args);
  const proposal = join(dir, "proposal.md");
  log.ok(`briefing written: ${relative(ws.root, briefing)}`);

  const git = isGitRepo(ws.root);
  if (args.apply && git && hasUncommittedChanges(ws.root)) {
    log.warn("dirty working tree: the diff below will mix your changes with the improver's");
  }

  const message = buildPrompt(ws, briefing, proposal, Boolean(args.apply));
  if (args.dryRun) {
    console.log(message);
    return 0;
  }

  log.step(`${c.bold(role.name)} ${c.dim(`(${resolveModel(ws.config, role.model)})`)}`);
  const run = await runAgent({
    binary: ws.config.opencode.binary,
    agent: role.name,
    model: resolveModel(ws.config, role.model),
    message,
    cwd: ws.root,
    env: ws.config.opencode.env,
    extraArgs: ws.config.opencode.args,
    timeoutMs: ws.config.run.timeoutMs,
    onChunk: args.verbose ? (chunk) => process.stderr.write(chunk) : undefined,
  });
  await writeFile(join(dir, "improver.md"), run.stdout, "utf8");

  if (run.code !== 0) {
    log.error(`the improver failed (exit ${run.code})`);
    if (run.stderr.trim()) log.detail(run.stderr.trim().split("\n").slice(-5).join("\n  "));
    return 1;
  }
  log.ok(`report: ${relative(ws.root, join(dir, "improver.md"))}`);

  if (!args.apply) {
    log.info("");
    log.info(`Proposal in ${c.cyan(relative(ws.root, proposal))}. Nothing was applied.`);
    log.info(`To apply and verify: ${c.cyan("harness improve --apply --eval")}`);
    return 0;
  }

  const diff = git ? diffFiles(ws.root, scopePaths) : "";
  if (git) {
    log.info("");
    log.info(diff.trim() ? diff : c.dim("no change inside the allowed scope"));
  } else {
    log.warn("not a git repository: no diff to show, and no automatic rollback");
  }

  // A changed prompt must still produce a valid configuration.
  const { validateWorkspace } = await import("./validate.ts");
  const reloaded = await loadWorkspace();
  const errors = await validateWorkspace(reloaded);
  if (errors.length > 0) {
    for (const error of errors) log.error(error);
    if (git && restoreFiles(ws.root, scopePaths)) log.ok("changes rolled back (invalid configuration)");
    return 1;
  }
  log.ok("configuration still valid");

  if (!args.evaluate) {
    log.info("");
    log.info(`Now measure the actual effect: ${c.cyan("harness eval")}`);
    return 0;
  }

  const results: EvaluationResult[] = [];
  for (const evaluation of reloaded.evals.values()) {
    results.push(await runEvaluation(reloaded, evaluation, { verbose: args.verbose }));
  }

  const regressions = results.filter((result) => {
    const before = baseline?.scores[result.evaluation];
    return before !== undefined && result.score < before;
  });

  log.info("");
  for (const result of results) {
    const before = baseline?.scores[result.evaluation];
    const arrow =
      before === undefined
        ? ""
        : result.score > before
          ? c.green(" ↑")
          : result.score < before
            ? c.red(" ↓")
            : c.dim(" =");
    log.info(`  ${result.evaluation.padEnd(24)} ${Math.round(result.score * 100)}%${arrow}`);
  }

  await new EventLog(join(fromRoot(ws.root, ".harness"), "improve.jsonl")).append({
    type: "eval_result",
    evaluation: "improve",
    score: results.reduce((sum, r) => sum + r.score, 0) / Math.max(results.length, 1),
    passed: results.filter((r) => r.score === 1).length,
    total: results.length,
  });

  if (regressions.length > 0) {
    log.error(`regression on: ${regressions.map((r) => r.evaluation).join(", ")}`);
    if (git && restoreFiles(ws.root, scopePaths)) log.ok("changes rolled back");
    else log.warn("roll back yourself: the changes are still on disk");
    return 1;
  }

  log.ok("no regression; run `harness eval --save-baseline` to lock in this level");
  return 0;
}
