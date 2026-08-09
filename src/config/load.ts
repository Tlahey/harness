import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { fail } from "../util/log.ts";
import {
  EvalSchema,
  HarnessConfigSchema,
  PipelineSchema,
  RoleSchema,
  isLoopStep,
  type Evaluation,
  type HarnessConfig,
  type Pipeline,
  type Role,
} from "./schema.ts";

export const CONFIG_FILENAME = "harness.config.yaml";

export interface Workspace {
  /** Directory holding harness.config.yaml. All relative paths resolve from here. */
  root: string;
  config: HarnessConfig;
  roles: Map<string, Role>;
  pipelines: Map<string, Pipeline>;
  evals: Map<string, Evaluation>;
}

function zodMessage(error: z.ZodError, file: string): string {
  const lines = error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `Invalid ${file}\n${lines.join("\n")}`;
}

async function readYaml(file: string): Promise<unknown> {
  const raw = await readFile(file, "utf8");
  try {
    return parseYaml(raw);
  } catch (err) {
    fail(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Walks up from `cwd` looking for harness.config.yaml, like git does for .git. */
export async function findRoot(cwd = process.cwd()): Promise<string> {
  let dir = resolve(cwd);
  for (;;) {
    if (await exists(join(dir, CONFIG_FILENAME))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) {
      fail(`No ${CONFIG_FILENAME} found in ${cwd} or any parent. Run \`harness init\` first.`);
    }
    dir = parent;
  }
}

export function fromRoot(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

// Generic over the schema, not over its output: `z.ZodType<T>` would make TS infer T from
// zod's *input* type, i.e. before `.default()` values are applied.
async function loadDir<S extends z.ZodTypeAny>(
  dir: string,
  schema: S,
  kind: string,
): Promise<Map<string, z.output<S>>> {
  const out = new Map<string, z.output<S>>();
  if (!(await exists(dir))) return out;

  const entries = (await readdir(dir)).filter((f) => [".yaml", ".yml"].includes(extname(f))).sort();
  for (const entry of entries) {
    const file = join(dir, entry);
    const data = (await readYaml(file)) ?? {};
    // The filename is the default name, so a role file rarely needs to repeat it.
    if (typeof data === "object" && data !== null && !("name" in data)) {
      (data as Record<string, unknown>).name = basename(entry, extname(entry));
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) fail(zodMessage(parsed.error, file));

    const value = parsed.data as z.output<S> & { name: string };
    if (out.has(value.name)) fail(`Duplicate ${kind} "${value.name}" (${file})`);
    out.set(value.name, value);
  }
  return out;
}

/** Detects cycles, dangling `needs` and broken loops before a pipeline is allowed to run. */
export function validatePipeline(pipeline: Pipeline, roles: Map<string, Role>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const topLevel = new Set<string>();

  const checkRole = (stepId: string, roleName: string) => {
    const role = roles.get(roleName);
    if (!role) errors.push(`step "${stepId}" references unknown role "${roleName}"`);
    else if (role.disabled) errors.push(`step "${stepId}" uses disabled role "${roleName}"`);
    // `opencode run --agent` refuses a pure subagent and silently falls back to the
    // default agent, which would run the step with the wrong prompt entirely.
    else if (role.mode === "subagent") {
      errors.push(`step "${stepId}" uses role "${roleName}" in mode "subagent"; use "all" to run it as a step`);
    }
  };
  const claim = (id: string) => {
    if (seen.has(id)) errors.push(`duplicate step id "${id}"`);
    seen.add(id);
  };

  for (const step of pipeline.steps) {
    claim(step.id);
    topLevel.add(step.id);

    if (!isLoopStep(step)) {
      checkRole(step.id, step.role);
      continue;
    }

    for (const body of step.loop.body) {
      claim(body.id);
      checkRole(body.id, body.role);
      if (body.needs.length > 0) {
        errors.push(`loop "${step.id}": step "${body.id}" cannot declare needs; a loop body runs in order`);
      }
    }
    const check = step.loop.check ?? step.loop.body[0]?.id;
    if (check && !step.loop.body.some((body) => body.id === check)) {
      errors.push(`loop "${step.id}": check step "${check}" is not part of its body`);
    }
    try {
      new RegExp(step.loop.until);
    } catch {
      errors.push(`loop "${step.id}": until is not a valid regex: ${step.loop.until}`);
    }
  }

  for (const step of pipeline.steps) {
    for (const need of step.needs) {
      if (!topLevel.has(need)) errors.push(`step "${step.id}" needs unknown step "${need}"`);
      if (need === step.id) errors.push(`step "${step.id}" needs itself`);
    }
  }

  // Kahn's algorithm: whatever is left over after the topological sweep is a cycle.
  const pending = new Map(
    pipeline.steps.map((s) => [s.id, new Set(s.needs.filter((n) => topLevel.has(n)))]),
  );
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, deps] of pending) {
      if (deps.size === 0) {
        pending.delete(id);
        for (const other of pending.values()) other.delete(id);
        progressed = true;
      }
    }
  }
  if (pending.size > 0) {
    errors.push(`dependency cycle between steps: ${[...pending.keys()].sort().join(", ")}`);
  }

  return errors;
}

export async function loadWorkspace(cwd = process.cwd()): Promise<Workspace> {
  const root = await findRoot(cwd);
  const configFile = join(root, CONFIG_FILENAME);
  const parsed = HarnessConfigSchema.safeParse((await readYaml(configFile)) ?? {});
  if (!parsed.success) fail(zodMessage(parsed.error, CONFIG_FILENAME));
  const config = parsed.data;

  const roles = await loadDir(fromRoot(root, config.paths.roles), RoleSchema, "role");
  const pipelines = await loadDir(fromRoot(root, config.paths.pipelines), PipelineSchema, "pipeline");
  const evals = await loadDir(fromRoot(root, config.paths.evals), EvalSchema, "eval");

  return { root, config, roles, pipelines, evals };
}

export function requireRole(ws: Workspace, name: string): Role {
  const role = ws.roles.get(name);
  if (!role) {
    const known = [...ws.roles.keys()].join(", ") || "(none defined)";
    fail(`Unknown role "${name}". Known roles: ${known}`);
  }
  if (role.disabled) fail(`Role "${name}" is disabled in its YAML file.`);
  return role;
}

export function requirePipeline(ws: Workspace, name: string): Pipeline {
  const pipeline = ws.pipelines.get(name);
  if (!pipeline) {
    const known = [...ws.pipelines.keys()].join(", ") || "(none defined)";
    fail(`Unknown pipeline "${name}". Known pipelines: ${known}`);
  }
  return pipeline;
}

export function requireEval(ws: Workspace, name: string): Evaluation {
  const evaluation = ws.evals.get(name);
  if (!evaluation) {
    const known = [...ws.evals.keys()].join(", ") || "(none defined)";
    fail(`Unknown eval "${name}". Known evals: ${known}`);
  }
  return evaluation;
}

/** Resolves a model alias (`smart`) to a provider id (`anthropic/claude-opus-4-5`). */
export function resolveModel(config: HarnessConfig, model: string | undefined): string {
  const raw = model ?? config.defaults.model;
  const aliased = config.models[raw] ?? raw;
  if (!aliased.includes("/")) {
    fail(
      `Model "${raw}" is neither a "provider/model" id nor an alias in \`models:\`.\n` +
        `  Known aliases: ${Object.keys(config.models).join(", ") || "(none)"}`,
    );
  }
  return aliased;
}
