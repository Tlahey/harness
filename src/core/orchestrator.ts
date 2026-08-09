import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fromRoot, requireRole, resolveModel, validatePipeline, type Workspace } from "../config/load.ts";
import { isLoopStep, type AgentStep, type LoopStep, type Pipeline, type Step } from "../config/schema.ts";
import { buildArgs, quote, runAgent } from "../opencode/exec.ts";
import { c, fail, log } from "../util/log.ts";
import { interpolate, type Scope } from "../util/template.ts";
import { EventLog } from "./events.ts";
import { readState } from "./state.ts";

export type StepStatus = "success" | "failed" | "skipped" | "restored";

export interface StepResult {
  id: string;
  role: string;
  model: string;
  status: StepStatus;
  exitCode: number | null;
  durationMs: number;
  /** Transcript path, relative to the workspace root. */
  outputFile: string | null;
  command: string | null;
  missingOutputs: string[];
  attempts: number;
  /** Set on body steps: the loop they belong to. */
  loopId?: string;
  /** Set on loop steps: how many times the body ran. */
  iterations?: number;
}

export interface RunManifest {
  runId: string;
  pipeline: string;
  startedAt: string;
  finishedAt: string | null;
  status: "success" | "failed" | "running";
  inputs: Record<string, string>;
  steps: StepResult[];
}

export interface RunOptions {
  inputs: Record<string, string>;
  dryRun?: boolean;
  concurrency?: number;
  /** Start at this step, treating everything before it as already done. */
  from?: string;
  /** Run only these steps. */
  only?: string[];
  /** Reuse a previous run directory and its recorded step outputs. */
  resume?: string;
  verbose?: boolean;
  /** Run in this directory instead of the workspace root (used by evals). */
  cwd?: string;
}

interface StepScopeEntry {
  output: string;
  file: string;
  status: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveInputs(pipeline: Pipeline, provided: Record<string, string>): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const spec of pipeline.inputs) {
    const value = provided[spec.name] ?? spec.default;
    if (value === undefined) {
      if (spec.required) {
        fail(`Missing required input "${spec.name}" for pipeline "${pipeline.name}". Pass --input ${spec.name}=...`);
      }
      continue;
    }
    inputs[spec.name] = value;
  }
  const declared = new Set(pipeline.inputs.map((i) => i.name));
  for (const key of Object.keys(provided)) {
    if (!declared.has(key)) log.warn(`Input "${key}" is not declared by pipeline "${pipeline.name}"; ignoring it.`);
  }
  return inputs;
}

/** Steps whose dependencies are all done, in the order they were written. */
function ready(steps: Step[], done: Set<string>, started: Set<string>): Step[] {
  return steps.filter((s) => !started.has(s.id) && s.needs.every((n) => done.has(n)));
}

function skipped(id: string, role: string): StepResult {
  return {
    id,
    role,
    model: "-",
    status: "skipped",
    exitCode: null,
    durationMs: 0,
    outputFile: null,
    command: null,
    missingOutputs: [],
    attempts: 0,
  };
}

export async function runPipeline(
  ws: Workspace,
  pipeline: Pipeline,
  opts: RunOptions,
): Promise<RunManifest> {
  const errors = validatePipeline(pipeline, ws.roles);
  if (errors.length > 0) fail(`Pipeline "${pipeline.name}" is invalid:\n  ${errors.join("\n  ")}`);

  const cwd = opts.cwd ?? ws.root;
  const inputs = resolveInputs(pipeline, opts.inputs);
  const runId = opts.resume ?? `${pipeline.name}-${timestamp()}`;
  const runDir = join(fromRoot(ws.root, ws.config.paths.artifacts), runId);
  if (!opts.dryRun) await mkdir(runDir, { recursive: true });

  const events = new EventLog(join(runDir, "events.jsonl"));
  const results = new Map<string, StepResult>();
  const stepScope: Record<string, StepScopeEntry> = {};
  const scope: Scope = {
    project: { name: ws.config.project.name },
    workspace: cwd,
    run: { id: runId, dir: runDir },
    input: inputs,
    state: await readState(ws),
    steps: stepScope,
  };

  const partial = Boolean(opts.only || opts.from);
  const selected = new Set(
    opts.only
      ? opts.only
      : opts.from
        ? stepsFrom(pipeline, opts.from)
        : pipeline.steps.map((s) => s.id),
  );
  for (const id of selected) {
    if (!pipeline.steps.some((s) => s.id === id)) fail(`Pipeline "${pipeline.name}" has no step "${id}"`);
  }

  // Resuming rehydrates earlier transcripts so `{{ steps.x.output }}` still resolves.
  // Steps explicitly re-selected with --from/--only are left out: the point is to redo them.
  if (opts.resume) {
    const previous = await loadManifest(runDir);
    if (!previous) fail(`No previous run found at ${relative(ws.root, runDir)}`);
    for (const step of previous.steps) {
      if (step.status !== "success" || !step.outputFile) continue;
      if (partial && selected.has(step.id)) continue;
      const file = fromRoot(ws.root, step.outputFile);
      stepScope[step.id] = {
        output: (await readFile(file, "utf8").catch(() => "")).trim(),
        file,
        status: "success",
      };
      results.set(step.id, { ...step, status: "restored" });
    }
  }

  const manifest: RunManifest = {
    runId,
    pipeline: pipeline.name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    inputs,
    steps: [],
  };
  const startedAt = Date.now();
  if (!opts.dryRun) await events.append({ type: "run_start", runId, pipeline: pipeline.name, inputs });

  const done = new Set<string>(results.keys());
  const started = new Set<string>(results.keys());
  const concurrency = opts.concurrency ?? pipeline.concurrency ?? ws.config.run.concurrency;
  let failed = false;

  /** Runs one agent step and records everything about it. Returns true on success. */
  const runAgentStep = async (
    step: AgentStep,
    context?: { loopId: string; iteration: number; max: number },
  ): Promise<boolean> => {
    const role = requireRole(ws, step.role);
    const model = resolveModel(ws.config, step.model ?? role.model);
    const label = context ? `${context.loopId}.${context.iteration}.${step.id}` : step.id;
    const outputFile = join(runDir, `${label}.md`);
    const where = `pipeline ${pipeline.name} > step ${label}`;
    const localScope: Scope = context
      ? { ...scope, loop: { id: context.loopId, iteration: context.iteration, max: context.max } }
      : scope;
    const message = interpolate(step.prompt, localScope, where);

    const agentOptions = {
      binary: ws.config.opencode.binary,
      agent: role.name,
      model,
      message,
      cwd,
      env: ws.config.opencode.env,
      extraArgs: ws.config.opencode.args,
      continueSession: step.continueSession,
      timeoutMs: step.timeoutMs ?? ws.config.run.timeoutMs,
    };

    const base: StepResult = {
      id: step.id,
      role: role.name,
      model,
      status: "failed",
      exitCode: null,
      durationMs: 0,
      outputFile: null,
      command: null,
      missingOutputs: [],
      attempts: 0,
      ...(context ? { loopId: context.loopId } : {}),
    };

    const prefix = context ? c.dim(`[${context.iteration}/${context.max}] `) : "";
    log.step(`${prefix}${c.bold(step.id)} ${c.dim(`(${role.name} · ${model})`)}`);

    if (opts.dryRun) {
      const command = quote([ws.config.opencode.binary, ...buildArgs(agentOptions)]);
      log.detail(command);
      results.set(step.id, { ...base, status: "success", command });
      stepScope[step.id] = { output: `<dry-run output of ${step.id}>`, file: outputFile, status: "success" };
      return true;
    }

    await events.append({
      type: "step_start",
      runId,
      stepId: step.id,
      role: role.name,
      model,
      ...(context ? { iteration: context.iteration } : {}),
    });

    let result = base;
    for (let attempt = 1; attempt <= step.retry + 1; attempt++) {
      const run = await runAgent({
        ...agentOptions,
        onChunk: opts.verbose ? (chunk) => process.stderr.write(chunk) : undefined,
      });

      await writeFile(outputFile, run.stdout, "utf8");
      result = {
        ...base,
        attempts: attempt,
        exitCode: run.code,
        durationMs: run.durationMs,
        outputFile: relative(ws.root, outputFile),
        command: quote(run.command),
        status: run.code === 0 ? "success" : "failed",
      };

      if (run.timedOut) log.warn(`${step.id} timed out`);
      if (run.code === 0) break;
      if (run.stderr.trim()) log.detail(run.stderr.trim().split("\n").slice(-5).join("\n  "));
      if (attempt <= step.retry) log.warn(`${step.id} failed (exit ${run.code}); retrying (${attempt}/${step.retry})`);
    }

    for (const path of [...role.outputs, ...step.outputs]) {
      if (!(await fileExists(join(cwd, path)))) result.missingOutputs.push(path);
    }

    results.set(step.id, result);
    stepScope[step.id] = {
      output: (await readFile(outputFile, "utf8").catch(() => "")).trim(),
      file: outputFile,
      status: result.status,
    };
    await events.append({
      type: "step_end",
      runId,
      stepId: step.id,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      attempts: result.attempts,
      missingOutputs: result.missingOutputs,
      ...(context ? { iteration: context.iteration } : {}),
    });

    if (result.status === "success") {
      const suffix = result.missingOutputs.length > 0 ? c.yellow(` (missing: ${result.missingOutputs.join(", ")})`) : "";
      log.ok(`${step.id} in ${Math.round(result.durationMs / 1000)}s${suffix}`);
      return true;
    }
    log.error(`${step.id} failed (exit ${result.exitCode})`);
    return false;
  };

  /** Runs the body until `until` matches, or the budget is spent. */
  const runLoop = async (step: LoopStep): Promise<void> => {
    const { until, max, body, onExhausted } = step.loop;
    const checkId = step.loop.check ?? body[0]!.id;
    const pattern = new RegExp(until);
    let matched = false;
    let iteration = 0;

    log.info(c.bold(`\n↻ ${step.id} — until /${until}/ (max ${max})`));

    for (iteration = 1; iteration <= max; iteration++) {
      for (const bodyStep of body) {
        const ok = await runAgentStep(bodyStep, { loopId: step.id, iteration, max });
        if (!ok) {
          results.set(step.id, { ...skipped(step.id, "loop"), status: "failed", iterations: iteration });
          failed = true;
          return;
        }

        // The condition is tested as soon as the checked step has spoken: no point running
        // the rest of the body (fix, retest) when it is already satisfied.
        if (bodyStep.id !== checkId) continue;
        matched = pattern.test(stepScope[checkId]?.output ?? "");
        if (!opts.dryRun) {
          await events.append({ type: "loop_iteration", runId, loopId: step.id, iteration, matched });
        }
        if (matched) break;
      }

      if (matched) {
        log.ok(`${step.id}: condition met on iteration ${iteration}`);
        break;
      }
      if (iteration < max) log.warn(`${step.id}: condition not met, running the body again`);
      if (opts.dryRun) break;
    }

    if (!matched && !opts.dryRun) {
      log.warn(`${step.id}: ${max} iterations without matching /${until}/`);
    }
    const status: StepStatus = matched || opts.dryRun || onExhausted === "continue" ? "success" : "failed";
    results.set(step.id, {
      ...skipped(step.id, "loop"),
      status,
      iterations: Math.min(iteration, max),
      durationMs: body.reduce((total, b) => total + (results.get(b.id)?.durationMs ?? 0), 0),
    });
    stepScope[step.id] = {
      output: stepScope[checkId]?.output ?? "",
      file: stepScope[checkId]?.file ?? "",
      status,
    };
    if (status === "failed") failed = true;
  };

  const runStep = async (step: Step): Promise<void> => {
    if (isLoopStep(step)) {
      await runLoop(step);
      if (results.get(step.id)?.status === "success") done.add(step.id);
      return;
    }
    const ok = await runAgentStep(step);
    if (ok) done.add(step.id);
    else failed = true;
  };

  const active = new Set<Promise<void>>();
  while (!failed) {
    const candidates: Step[] = [];
    let skippedAny = false;
    for (const step of ready(pipeline.steps, done, started)) {
      if (selected.has(step.id)) {
        candidates.push(step);
        continue;
      }
      // Unselected steps are marked satisfied so the rest of the DAG can proceed.
      started.add(step.id);
      done.add(step.id);
      skippedAny = true;
      if (!results.has(step.id)) results.set(step.id, skipped(step.id, isLoopStep(step) ? "loop" : step.role));
    }

    if (candidates.length === 0 && active.size === 0) {
      // Skipping unblocked new steps; re-evaluate before concluding the run is over.
      if (skippedAny) continue;
      break;
    }

    for (const step of candidates.slice(0, Math.max(0, concurrency - active.size))) {
      started.add(step.id);
      const promise = runStep(step).finally(() => active.delete(promise));
      active.add(promise);
    }
    if (active.size > 0) await Promise.race(active);
  }
  await Promise.allSettled(active);

  manifest.steps = pipeline.steps.flatMap((step) => {
    const own = results.get(step.id) ?? skipped(step.id, isLoopStep(step) ? "loop" : step.role);
    if (!isLoopStep(step)) return [own];
    return [own, ...step.loop.body.map((body) => results.get(body.id) ?? skipped(body.id, body.role))];
  });
  manifest.finishedAt = new Date().toISOString();
  manifest.status = manifest.steps.some((s) => s.status === "failed") ? "failed" : "success";

  if (!opts.dryRun) {
    await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await events.append({
      type: "run_end",
      runId,
      status: manifest.status,
      durationMs: Date.now() - startedAt,
    });
  }
  return manifest;
}

/** The requested step plus everything that transitively depends on it. */
function stepsFrom(pipeline: Pipeline, from: string): string[] {
  const selected = new Set([from]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of pipeline.steps) {
      if (selected.has(step.id)) continue;
      if (step.needs.some((n) => selected.has(n))) {
        selected.add(step.id);
        grew = true;
      }
    }
  }
  return [...selected];
}

export async function loadManifest(runDir: string): Promise<RunManifest | null> {
  try {
    return JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as RunManifest;
  } catch {
    return null;
  }
}
