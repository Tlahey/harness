import { stat } from "node:fs/promises";
import { fromRoot, loadWorkspace, resolveModel, validatePipeline, type Workspace } from "../config/load.ts";
import { isLoopStep, type AgentStep, type Pipeline } from "../config/schema.ts";
import { HarnessError, c, log } from "../util/log.ts";
import { placeholders } from "../util/template.ts";

async function missing(root: string, path: string): Promise<boolean> {
  try {
    await stat(fromRoot(root, path));
    return false;
  } catch {
    return true;
  }
}

function check(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof HarnessError ? (err.message.split("\n")[0] ?? err.message) : String(err);
  }
}

/** Placeholders a step may legitimately use, given what has run before it. */
function allowedFor(
  pipeline: Pipeline,
  context: { needs: string[]; loopBodyBefore?: string[] },
): Set<string> {
  const allowed = new Set([
    "project.name",
    "workspace",
    "run.id",
    "run.dir",
    ...pipeline.inputs.map((input) => `input.${input.name}`),
  ]);

  const expose = (id: string) => {
    for (const field of ["output", "file", "status"]) allowed.add(`steps.${id}.${field}`);
  };

  for (const need of context.needs) {
    expose(need);
    // Depending on a loop also exposes what its body produced.
    const target = pipeline.steps.find((s) => s.id === need);
    if (target && isLoopStep(target)) for (const body of target.loop.body) expose(body.id);
  }
  for (const id of context.loopBodyBefore ?? []) expose(id);
  if (context.loopBodyBefore) {
    allowed.add("loop.id");
    allowed.add("loop.iteration");
    allowed.add("loop.max");
  }
  return allowed;
}

/** Static checks that would otherwise only surface halfway through an expensive run. */
export async function validateWorkspace(ws: Workspace): Promise<string[]> {
  const errors: string[] = [];

  const defaultModel = check(() => resolveModel(ws.config, undefined));
  if (defaultModel) errors.push(`defaults.model: ${defaultModel}`);

  for (const path of ws.config.instructions) {
    if (await missing(ws.root, path)) errors.push(`instructions: file not found: ${path}`);
  }

  for (const role of ws.roles.values()) {
    const modelError = check(() => resolveModel(ws.config, role.model));
    if (modelError) errors.push(`role "${role.name}": ${modelError}`);

    for (const path of role.instructions) {
      if (await missing(ws.root, path)) errors.push(`role "${role.name}": instructions file not found: ${path}`);
    }

    for (const member of role.team) {
      if (!ws.roles.has(member)) errors.push(`role "${role.name}": unknown teammate "${member}"`);
      else if (ws.roles.get(member)?.mode === "primary") {
        log.warn(`role "${role.name}": "${member}" is mode "primary" and cannot be delegated to`);
      }
    }
    const tools = { ...ws.config.defaults.tools, ...role.tools };
    if (role.team.length > 0 && tools.task === false) {
      errors.push(`role "${role.name}": has a team but the "task" tool is disabled`);
    }

    const permission = { ...ws.config.defaults.permission, ...role.permission };
    if (role.memory === "write" && permission.edit === "deny") {
      errors.push(`role "${role.name}": memory "write" but permission.edit "deny"`);
    }
    if (permission.bash === "ask" || permission.edit === "ask") {
      log.warn(`role "${role.name}": permission "ask" cannot be answered in a headless pipeline run`);
    }
  }

  for (const pipeline of ws.pipelines.values()) {
    for (const error of validatePipeline(pipeline, ws.roles)) {
      errors.push(`pipeline "${pipeline.name}": ${error}`);
    }

    const verify = (step: AgentStep, allowed: Set<string>) => {
      for (const key of placeholders(step.prompt)) {
        // State keys are created at runtime; only the namespace can be checked here.
        if (key.startsWith("state.") || allowed.has(key)) continue;
        const hint = key.startsWith("steps.") ? ` (add "${key.split(".")[1]}" to needs, or check the field)` : "";
        errors.push(`pipeline "${pipeline.name}" step "${step.id}": unknown placeholder {{ ${key} }}${hint}`);
      }
    };

    for (const step of pipeline.steps) {
      if (!isLoopStep(step)) {
        verify(step, allowedFor(pipeline, { needs: step.needs }));
        continue;
      }
      const before: string[] = [];
      for (const body of step.loop.body) {
        verify(body, allowedFor(pipeline, { needs: step.needs, loopBodyBefore: before }));
        before.push(body.id);
      }
    }
  }

  const improver = ws.roles.get(ws.config.improve.role);
  if (!improver) errors.push(`improve.role: unknown role "${ws.config.improve.role}"`);
  else if (improver.mode === "subagent") {
    errors.push(`improve.role "${improver.name}" is mode "subagent"; use "all" or "primary"`);
  }

  for (const evaluation of ws.evals.values()) {
    if (!ws.pipelines.has(evaluation.pipeline)) {
      errors.push(`eval "${evaluation.name}": unknown pipeline "${evaluation.pipeline}"`);
    }
    for (const assertion of evaluation.assert) {
      if (assertion.type === "judge") {
        const judge = ws.roles.get(assertion.role);
        if (!judge) errors.push(`eval "${evaluation.name}": unknown judge role "${assertion.role}"`);
        else if (judge.mode === "subagent") {
          errors.push(`eval "${evaluation.name}": judge "${assertion.role}" is mode "subagent"; use "all"`);
        }
      }
      if (assertion.type === "step_output") {
        const pipeline = ws.pipelines.get(evaluation.pipeline);
        const ids = pipeline
          ? pipeline.steps.flatMap((s) => (isLoopStep(s) ? [s.id, ...s.loop.body.map((b) => b.id)] : [s.id]))
          : [];
        if (pipeline && !ids.includes(assertion.step)) {
          errors.push(`eval "${evaluation.name}": unknown step "${assertion.step}"`);
        }
      }
    }
  }

  return errors;
}

export async function validateCommand(): Promise<number> {
  const ws = await loadWorkspace();
  const errors = await validateWorkspace(ws);

  if (errors.length > 0) {
    for (const error of errors) log.error(error);
    return 1;
  }
  log.ok(
    `${ws.roles.size} role(s), ${ws.pipelines.size} pipeline(s), ${ws.evals.size} eval(s) valid ` +
      c.dim(`(${ws.config.project.name})`),
  );
  return 0;
}
