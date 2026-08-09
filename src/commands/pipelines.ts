import { dirname } from "node:path";
import { loadWorkspace, requirePipeline, resolveModel } from "../config/load.ts";
import { isLoopStep, type AgentStep } from "../config/schema.ts";
import { runPipeline, type RunManifest } from "../core/orchestrator.ts";
import { c, log } from "../util/log.ts";

export async function listPipelines(): Promise<void> {
  const ws = await loadWorkspace();
  if (ws.pipelines.size === 0) {
    log.warn(`No pipelines found in ${ws.config.paths.pipelines}`);
    return;
  }
  const width = Math.max(...[...ws.pipelines.keys()].map((n) => n.length));
  for (const pipeline of ws.pipelines.values()) {
    const steps = `${pipeline.steps.length} step(s)`;
    console.log(
      `${c.bold(pipeline.name.padEnd(width))}  ${c.magenta(steps.padEnd(12))} ${c.dim(pipeline.description ?? "")}`,
    );
  }
}

export async function showPipeline(name: string): Promise<void> {
  const ws = await loadWorkspace();
  const pipeline = requirePipeline(ws, name);

  console.log(`${c.bold(pipeline.name)}${pipeline.description ? c.dim(` — ${pipeline.description}`) : ""}`);
  if (pipeline.inputs.length > 0) {
    console.log(c.dim("\ninputs"));
    for (const input of pipeline.inputs) {
      const flag = input.required ? c.yellow("required") : c.dim("optional");
      console.log(`  ${input.name.padEnd(16)} ${flag}  ${c.dim(input.description ?? "")}`);
    }
  }

  const describe = (step: AgentStep, indent: string, needs: string) => {
    const role = ws.roles.get(step.role);
    const model = role ? resolveModel(ws.config, step.model ?? role.model) : c.red("unknown role");
    console.log(`${indent}${c.bold(step.id.padEnd(12))} ${step.role.padEnd(12)} ${c.magenta(model)}${needs}`);
  };

  console.log(c.dim("\nsteps"));
  for (const step of pipeline.steps) {
    const needs = step.needs.length > 0 ? c.dim(` after ${step.needs.join(", ")}`) : "";
    if (!isLoopStep(step)) {
      describe(step, "  ", needs);
      continue;
    }
    const { until, max, body } = step.loop;
    const check = step.loop.check ?? body[0]?.id;
    console.log(`  ${c.bold(step.id.padEnd(12))} ${c.cyan("↻ loop")}       until /${until}/ on ${check}, max ${max}${needs}`);
    for (const bodyStep of body) describe(bodyStep, "    ", "");
  }
}

function printSummary(manifest: RunManifest): void {
  const icon = { success: c.green("✓"), restored: c.dim("·"), skipped: c.dim("-"), failed: c.red("✗") };
  log.info("");
  log.info(c.bold(`run ${manifest.runId}`));
  for (const step of manifest.steps) {
    const duration = step.durationMs > 0 ? `${Math.round(step.durationMs / 1000)}s` : "";
    const missing = step.missingOutputs.length > 0 ? c.yellow(`  missing: ${step.missingOutputs.join(", ")}`) : "";
    log.info(
      `  ${icon[step.status]} ${step.id.padEnd(12)} ${c.dim(step.role.padEnd(12))} ${duration.padEnd(6)}${missing}`,
    );
  }
  const transcript = manifest.steps.find((s) => s.outputFile)?.outputFile;
  if (transcript) log.info(c.dim(`  transcripts: ${dirname(transcript)}/`));
}

export interface PipelineRunArgs {
  name: string;
  inputs: Record<string, string>;
  dryRun?: boolean;
  concurrency?: number;
  from?: string;
  only?: string[];
  resume?: string;
  verbose?: boolean;
}

export async function runPipelineCommand(args: PipelineRunArgs): Promise<number> {
  const ws = await loadWorkspace();
  const pipeline = requirePipeline(ws, args.name);

  const manifest = await runPipeline(ws, pipeline, {
    inputs: args.inputs,
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    from: args.from,
    only: args.only,
    resume: args.resume,
    verbose: args.verbose,
  });

  if (!args.dryRun) printSummary(manifest);
  return manifest.status === "failed" ? 1 : 0;
}
