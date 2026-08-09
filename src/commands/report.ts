import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fromRoot, loadWorkspace, type Workspace } from "../config/load.ts";
import { EventLog, type StampedEvent } from "../core/events.ts";
import { loadManifest, type RunManifest } from "../core/orchestrator.ts";
import { c, fail, log } from "../util/log.ts";

async function runDirs(ws: Workspace): Promise<string[]> {
  const dir = fromRoot(ws.root, ws.config.paths.artifacts);
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function timeline(events: StampedEvent[]): void {
  for (const event of events) {
    if (event.type === "loop_iteration") {
      const verdict = event.matched ? c.green("condition met") : c.yellow("not met");
      log.info(`  ${c.dim(event.at.slice(11, 19))} ↻ ${event.loopId} iteration ${event.iteration} — ${verdict}`);
    }
    if (event.type === "step_end") {
      const icon = event.status === "success" ? c.green("✓") : c.red("✗");
      const iteration = event.iteration ? c.dim(` [${event.iteration}]`) : "";
      const missing = event.missingOutputs.length > 0 ? c.yellow(` missing: ${event.missingOutputs.join(", ")}`) : "";
      const retries = event.attempts > 1 ? c.yellow(` ${event.attempts} attempts`) : "";
      log.info(
        `  ${c.dim(event.at.slice(11, 19))} ${icon} ${event.stepId}${iteration} ${seconds(event.durationMs)}${retries}${missing}`,
      );
    }
  }
}

async function single(ws: Workspace, runId: string): Promise<number> {
  const dir = join(fromRoot(ws.root, ws.config.paths.artifacts), runId);
  const manifest = await loadManifest(dir);
  if (!manifest) fail(`No manifest in ${dir}. Run \`harness runs\` to list what exists.`);

  const events = await EventLog.read(join(dir, "events.jsonl"));
  const total = manifest.steps.reduce((sum, step) => sum + step.durationMs, 0);

  log.info(`${c.bold(manifest.runId)} ${c.dim(`(${manifest.pipeline})`)} — ${manifest.status}`);
  log.info(c.dim(`${manifest.startedAt} → ${manifest.finishedAt ?? "?"}  ·  ${seconds(total)} of agent time`));
  log.info("");
  timeline(events);

  const failed = manifest.steps.filter((step) => step.status === "failed");
  const missing = manifest.steps.flatMap((step) => step.missingOutputs.map((path) => `${step.id} → ${path}`));
  if (failed.length > 0) {
    log.info("");
    log.info(c.bold("Failures"));
    for (const step of failed) log.info(`  ${step.id} (${step.role}, exit ${step.exitCode}) — ${step.outputFile ?? ""}`);
  }
  if (missing.length > 0) {
    log.info("");
    log.info(c.bold("Deliverables never written"));
    for (const entry of missing) log.info(`  ${entry}`);
  }
  return manifest.status === "failed" ? 1 : 0;
}

interface RoleStats {
  runs: number;
  failures: number;
  totalMs: number;
  retries: number;
  missing: number;
}

async function aggregate(ws: Workspace, limit: number): Promise<number> {
  const dirs = (await runDirs(ws)).reverse().slice(0, limit);
  const manifests: RunManifest[] = [];
  for (const name of dirs) {
    const manifest = await loadManifest(join(fromRoot(ws.root, ws.config.paths.artifacts), name));
    if (manifest) manifests.push(manifest);
  }
  if (manifests.length === 0) {
    log.warn("No runs recorded yet.");
    return 0;
  }

  const byRole = new Map<string, RoleStats>();
  for (const manifest of manifests) {
    for (const step of manifest.steps) {
      if (step.status === "skipped" || step.role === "loop") continue;
      const stats = byRole.get(step.role) ?? { runs: 0, failures: 0, totalMs: 0, retries: 0, missing: 0 };
      stats.runs++;
      if (step.status === "failed") stats.failures++;
      stats.totalMs += step.durationMs;
      stats.retries += Math.max(0, step.attempts - 1);
      stats.missing += step.missingOutputs.length;
      byRole.set(step.role, stats);
    }
  }

  const failedRuns = manifests.filter((manifest) => manifest.status === "failed").length;
  log.info(`${c.bold(`${manifests.length} run(s)`)} — ${manifests.length - failedRuns} succeeded, ${failedRuns} failed`);
  log.info("");
  log.info(c.dim("role          runs  failed  retries  missing deliverables  average"));
  for (const [role, stats] of [...byRole].sort(([, a], [, b]) => b.failures - a.failures)) {
    log.info(
      `${role.padEnd(14)}${String(stats.runs).padEnd(6)}${String(stats.failures).padEnd(8)}` +
        `${String(stats.retries).padEnd(9)}${String(stats.missing).padEnd(22)}${seconds(stats.totalMs / stats.runs)}`,
    );
  }

  log.info("");
  log.info(c.dim("A role that keeps failing or forgetting its deliverables is a prompt to fix:"));
  log.info(c.dim("  harness improve"));
  return 0;
}

export async function reportCommand(args: { runId?: string; all?: boolean; limit?: number }): Promise<number> {
  const ws = await loadWorkspace();
  if (args.all) return await aggregate(ws, args.limit ?? 20);

  const runId = args.runId ?? (await runDirs(ws)).at(-1);
  if (!runId) {
    log.warn("No runs recorded yet.");
    return 0;
  }
  return await single(ws, runId);
}
