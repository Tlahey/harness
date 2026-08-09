import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fromRoot, loadWorkspace } from "../config/load.ts";
import { loadManifest } from "../core/orchestrator.ts";
import { c, fail, log } from "../util/log.ts";

export async function listRuns(): Promise<void> {
  const ws = await loadWorkspace();
  const dir = fromRoot(ws.root, ws.config.paths.artifacts);

  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    log.warn("No runs yet.");
    return;
  }

  for (const name of entries.sort().reverse()) {
    const manifest = await loadManifest(join(dir, name));
    const status = manifest?.status ?? "unknown";
    const color = status === "success" ? c.green : status === "failed" ? c.red : c.dim;
    const failedSteps = manifest?.steps.filter((s) => s.status === "failed").map((s) => s.id) ?? [];
    const detail = failedSteps.length > 0 ? c.dim(` failed: ${failedSteps.join(", ")}`) : "";
    console.log(`${name.padEnd(34)} ${color(status.padEnd(8))}${detail}`);
  }
}

export async function showRun(runId: string): Promise<void> {
  const ws = await loadWorkspace();
  const dir = join(fromRoot(ws.root, ws.config.paths.artifacts), runId);
  const manifest = await loadManifest(dir);
  if (!manifest) fail(`No manifest at ${dir}. Run \`harness runs list\` to see available runs.`);

  console.log(`${c.bold(manifest.runId)} ${c.dim(`(${manifest.pipeline})`)}  ${manifest.status}`);
  console.log(c.dim(`started ${manifest.startedAt}  finished ${manifest.finishedAt ?? "-"}`));
  for (const [key, value] of Object.entries(manifest.inputs)) {
    console.log(`  input ${key}: ${value}`);
  }
  console.log("");
  for (const step of manifest.steps) {
    console.log(
      `  ${step.id.padEnd(12)} ${step.status.padEnd(9)} ${step.role.padEnd(12)} ${c.magenta(step.model)} ` +
        `${Math.round(step.durationMs / 1000)}s`,
    );
    if (step.outputFile) console.log(c.dim(`    ${step.outputFile}`));
    if (step.missingOutputs.length > 0) console.log(c.yellow(`    missing: ${step.missingOutputs.join(", ")}`));
    if (step.command) console.log(c.dim(`    ${step.command}`));
  }
}
