import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromRoot, requirePipeline, requireRole, resolveModel, type Workspace } from "../config/load.ts";
import type { Assertion, Evaluation } from "../config/schema.ts";
import { runAgent } from "../opencode/exec.ts";
import { addWorktree, isGitRepo, removeWorktree } from "../util/git.ts";
import { c, fail, log } from "../util/log.ts";
import { EventLog } from "./events.ts";
import { runPipeline, type RunManifest } from "./orchestrator.ts";

export interface AssertionResult {
  type: Assertion["type"];
  label: string;
  passed: boolean;
  weight: number;
  detail: string;
}

export interface EvaluationResult {
  evaluation: string;
  runId: string;
  /** Weighted ratio of satisfied assertions, 0 to 1. */
  score: number;
  passed: number;
  total: number;
  pipelineStatus: RunManifest["status"];
  assertions: AssertionResult[];
  workspace: string;
  at: string;
}

export interface EvaluateOptions {
  /** Run in the workspace itself instead of an isolated git worktree. */
  inPlace?: boolean;
  /** Keep the worktree after the run, to inspect what the agents produced. */
  keep?: boolean;
  verbose?: boolean;
}

function label(assertion: Assertion): string {
  switch (assertion.type) {
    case "file_exists":
      return `${assertion.path} exists`;
    case "file_contains":
      return `${assertion.path} matches /${assertion.pattern}/`;
    case "command":
      return `\`${assertion.run}\` exits ${assertion.expectExit}`;
    case "step_output":
      return `${assertion.step} output matches /${assertion.pattern}/`;
    case "judge":
      return `judged by ${assertion.role}`;
  }
}

async function check(
  ws: Workspace,
  assertion: Assertion,
  ctx: { cwd: string; manifest: RunManifest },
): Promise<{ passed: boolean; detail: string }> {
  switch (assertion.type) {
    case "file_exists": {
      const content = await readFile(join(ctx.cwd, assertion.path), "utf8").catch(() => null);
      return content === null
        ? { passed: false, detail: "file missing" }
        : { passed: true, detail: `${content.length} characters` };
    }

    case "file_contains": {
      const content = await readFile(join(ctx.cwd, assertion.path), "utf8").catch(() => null);
      if (content === null) return { passed: false, detail: "file missing" };
      return new RegExp(assertion.pattern, "m").test(content)
        ? { passed: true, detail: "pattern found" }
        : { passed: false, detail: "pattern not found" };
    }

    case "command": {
      const result = spawnSync(assertion.run, { cwd: ctx.cwd, shell: true, encoding: "utf8" });
      const code = result.status ?? 1;
      const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" / ");
      return { passed: code === assertion.expectExit, detail: `code ${code}${tail ? ` — ${tail}` : ""}` };
    }

    case "step_output": {
      const step = ctx.manifest.steps.find((s) => s.id === assertion.step);
      if (!step?.outputFile) return { passed: false, detail: "step never ran" };
      const content = await readFile(fromRoot(ws.root, step.outputFile), "utf8").catch(() => "");
      return new RegExp(assertion.pattern, "m").test(content)
        ? { passed: true, detail: "pattern found" }
        : { passed: false, detail: "pattern not found" };
    }

    case "judge": {
      const role = requireRole(ws, assertion.role);
      const run = await runAgent({
        binary: ws.config.opencode.binary,
        agent: role.name,
        model: resolveModel(ws.config, role.model),
        message: assertion.prompt,
        cwd: ctx.cwd,
        env: ws.config.opencode.env,
        extraArgs: ws.config.opencode.args,
        timeoutMs: ws.config.run.timeoutMs,
      });
      if (run.code !== 0) return { passed: false, detail: `judge failed (exit ${run.code})` };
      const verdict = /VERDICT:\s*(pass|fail)/i.exec(run.stdout);
      if (!verdict) return { passed: false, detail: "no `VERDICT: pass|fail` line in the answer" };
      return {
        passed: verdict[1]!.toLowerCase() === "pass",
        detail: run.stdout.trim().split("\n").slice(-1)[0] ?? "",
      };
    }
  }
}

/**
 * Runs the pipeline on a scenario, then scores the result. Isolation matters more than it
 * looks: without it an eval rewrites the very working tree you are judging.
 */
export async function runEvaluation(
  ws: Workspace,
  evaluation: Evaluation,
  opts: EvaluateOptions = {},
): Promise<EvaluationResult> {
  const pipeline = requirePipeline(ws, evaluation.pipeline);
  const runId = `${evaluation.name}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const evalDir = join(fromRoot(ws.root, ".harness/evals"), runId);
  const workspace = join(evalDir, "workspace");
  await mkdir(evalDir, { recursive: true });

  let cwd = ws.root;
  let isolated = false;
  if (!opts.inPlace) {
    if (!isGitRepo(ws.root)) {
      fail(
        "An eval runs agents that write files. Without a git repository there is no isolation:\n" +
          "  initialise one, or accept the risk with `harness eval --in-place`.",
      );
    }
    const worktree = addWorktree(ws.root, workspace);
    if (!worktree.ok) fail(`Could not create the worktree: ${worktree.error}`);
    cwd = workspace;
    isolated = true;
    log.detail(`isolated worktree: ${workspace}`);
  } else {
    log.warn("--in-place: agents are writing into your working tree");
  }

  try {
    log.info(c.bold(`\n▶ eval ${evaluation.name} — pipeline ${pipeline.name}`));
    const manifest = await runPipeline(ws, pipeline, {
      inputs: evaluation.inputs,
      verbose: opts.verbose,
      cwd,
    });

    const assertions: AssertionResult[] = [];
    for (const assertion of evaluation.assert) {
      const outcome = await check(ws, assertion, { cwd, manifest });
      assertions.push({
        type: assertion.type,
        label: assertion.description ?? label(assertion),
        passed: outcome.passed,
        weight: assertion.weight,
        detail: outcome.detail,
      });
    }

    const total = assertions.reduce((sum, a) => sum + a.weight, 0);
    const earned = assertions.filter((a) => a.passed).reduce((sum, a) => sum + a.weight, 0);
    const result: EvaluationResult = {
      evaluation: evaluation.name,
      runId: manifest.runId,
      score: total === 0 ? 0 : earned / total,
      passed: assertions.filter((a) => a.passed).length,
      total: assertions.length,
      pipelineStatus: manifest.status,
      assertions,
      workspace: cwd,
      at: new Date().toISOString(),
    };

    await writeFile(join(evalDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await new EventLog(join(fromRoot(ws.root, ".harness"), "evals.jsonl")).append({
      type: "eval_result",
      evaluation: evaluation.name,
      score: result.score,
      passed: result.passed,
      total: result.total,
    });
    return result;
  } finally {
    if (isolated && !opts.keep) removeWorktree(ws.root, workspace);
    else if (isolated) log.detail(`worktree kept: ${workspace}`);
  }
}

export interface Baseline {
  /** eval name -> best known score */
  scores: Record<string, number>;
  at: string;
}

export function baselinePath(ws: Workspace): string {
  return join(fromRoot(ws.root, ".harness"), "baseline.json");
}

export async function readBaseline(ws: Workspace): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(baselinePath(ws), "utf8")) as Baseline;
  } catch {
    return null;
  }
}

export async function writeBaseline(ws: Workspace, results: EvaluationResult[]): Promise<Baseline> {
  const baseline: Baseline = {
    scores: Object.fromEntries(results.map((r) => [r.evaluation, r.score])),
    at: new Date().toISOString(),
  };
  await mkdir(fromRoot(ws.root, ".harness"), { recursive: true });
  await writeFile(baselinePath(ws), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return baseline;
}
