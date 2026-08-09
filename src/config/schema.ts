import { z } from "zod";

/** `allow` runs without asking, `ask` prompts the user, `deny` blocks the tool. */
export const PermissionValue = z.enum(["allow", "ask", "deny"]);

/**
 * Mirrors opencode's `permission` block. `bash` accepts either a single value or
 * a map of command globs, e.g. `{ "git push": "ask", "*": "allow" }`.
 */
export const PermissionSchema = z
  .object({
    edit: PermissionValue,
    webfetch: PermissionValue,
    bash: z.union([PermissionValue, z.record(PermissionValue)]),
  })
  .partial();

/** Tool allowlist passed through to opencode, e.g. `{ write: false, bash: true }`. */
export const ToolsSchema = z.record(z.boolean());

const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lower-kebab-case (a-z, 0-9, -)");

export const RoleSchema = z.object({
  name: identifier,
  description: z.string().min(1, "a role needs a description; opencode shows it when delegating"),
  /** Model alias declared in `models:` or a raw `provider/model` id. Falls back to `defaults.model`. */
  model: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).default("all"),
  temperature: z.number().min(0).max(2).optional(),
  tools: ToolsSchema.optional(),
  permission: PermissionSchema.optional(),
  /** Extra markdown files inlined at the end of the system prompt. */
  instructions: z.array(z.string()).default([]),
  /** The system prompt. This is what actually defines the role. */
  prompt: z.string().min(1),
  /** Files the role is contractually expected to produce; injected into the prompt and checked after a run. */
  outputs: z.array(z.string()).default([]),
  /**
   * Subagents this role may delegate to with the `task` tool. Listed in its prompt,
   * so the role knows who exists and what each one is for.
   */
  team: z.array(identifier).default([]),
  /** `read` injects the memory index into the prompt; `write` also asks the role to record what it learned. */
  memory: z.enum(["none", "read", "write"]).default("read"),
  disabled: z.boolean().default(false),
});

export const AgentStepSchema = z.object({
  id: identifier,
  role: identifier,
  /** User message sent to the role. Supports `{{ ... }}` interpolation. */
  prompt: z.string().min(1),
  /** Step ids that must finish first. Steps with satisfied deps run concurrently. */
  needs: z.array(identifier).default([]),
  /** Overrides the role's model for this step only. */
  model: z.string().optional(),
  /** Reuse the role's previous opencode session instead of starting a fresh one. */
  continueSession: z.boolean().default(false),
  outputs: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
  retry: z.number().int().min(0).max(5).default(0),
});

/**
 * A loop runs its body in order, over and over, until `until` matches the output of the
 * checked step. This is what turns review -> fix -> review into an actual iteration
 * instead of a single pass.
 */
export const LoopStepSchema = z.object({
  id: identifier,
  needs: z.array(identifier).default([]),
  loop: z.object({
    /** Regex tested against the checked step's output. Matching ends the loop. */
    until: z.string().min(1),
    /** Which body step to test. Defaults to the first one. */
    check: identifier.optional(),
    max: z.number().int().min(1).max(20).default(3),
    /** Budget spent without the condition being met: stop the pipeline, or carry on anyway. */
    onExhausted: z.enum(["fail", "continue"]).default("fail"),
    /** Body steps run sequentially; `needs` is not allowed inside a loop. */
    body: z.array(AgentStepSchema).min(1),
  }),
});

export const StepSchema = z.union([LoopStepSchema, AgentStepSchema]);

export const PipelineInputSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  description: z.string().optional(),
  required: z.boolean().default(true),
  default: z.string().optional(),
});

export const PipelineSchema = z.object({
  name: identifier,
  description: z.string().optional(),
  inputs: z.array(PipelineInputSchema).default([]),
  concurrency: z.number().int().positive().optional(),
  steps: z.array(StepSchema).min(1),
});

const AssertionBase = { weight: z.number().positive().default(1), description: z.string().optional() };

export const AssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file_exists"), path: z.string(), ...AssertionBase }),
  z.object({ type: z.literal("file_contains"), path: z.string(), pattern: z.string(), ...AssertionBase }),
  z.object({ type: z.literal("command"), run: z.string(), expectExit: z.number().int().default(0), ...AssertionBase }),
  z.object({ type: z.literal("step_output"), step: identifier, pattern: z.string(), ...AssertionBase }),
  /** An agent scores the result. Its last line must be `VERDICT: pass` or `VERDICT: fail`. */
  z.object({ type: z.literal("judge"), role: identifier, prompt: z.string(), ...AssertionBase }),
]);

export const EvalSchema = z.object({
  name: identifier,
  description: z.string().optional(),
  pipeline: identifier,
  inputs: z.record(z.string()).default({}),
  assert: z.array(AssertionSchema).min(1),
});

export const HarnessConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  defaults: z
    .object({
      /** Required: every role without an explicit model inherits this one. */
      model: z.string().min(1),
      temperature: z.number().min(0).max(2).optional(),
      tools: ToolsSchema.optional(),
      permission: PermissionSchema.optional(),
    })
    .strict(),
  /** Aliases so a model swap is a one-line change: `smart: anthropic/claude-opus-4-5`. */
  models: z.record(z.string()).default({}),
  paths: z
    .object({
      roles: z.string().default("./roles"),
      pipelines: z.string().default("./pipelines"),
      evals: z.string().default("./evals"),
      artifacts: z.string().default("./.harness/runs"),
      /** Where generated system prompts land; referenced from opencode.json with {file:...}. */
      prompts: z.string().default("./.opencode/prompt"),
      opencodeConfig: z.string().default("./opencode.json"),
      memory: z.string().default("./memory"),
      state: z.string().default("./.harness/state.json"),
    })
    .default({}),
  opencode: z
    .object({
      binary: z.string().default("opencode"),
      /** Appended to every `opencode run` invocation. */
      args: z.array(z.string()).default([]),
      env: z.record(z.string()).default({}),
    })
    .default({}),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      /** Index file listing every memory entry; injected into prompts. */
      index: z.string().default("MEMORY.md"),
      /** Above this, `harness memory prune` starts complaining. */
      maxEntries: z.number().int().positive().default(50),
    })
    .default({}),
  improve: z
    .object({
      role: identifier.default("improver"),
      /** Files the improver is allowed to rewrite. Anything else is off limits. */
      scope: z.array(z.string()).default(["roles/", "memory/"]),
      /** Refuse to improve without a passing eval baseline to compare against. */
      requireBaseline: z.boolean().default(true),
    })
    .default({}),
  /**
   * Custom providers, passed through verbatim to opencode.json. Required for anything
   * opencode does not know natively: a local Ollama or LM Studio server, a self-hosted
   * vLLM endpoint, any OpenAI-compatible gateway.
   */
  provider: z.record(z.any()).default({}),
  /** Passed through verbatim to opencode.json. */
  mcp: z.record(z.any()).default({}),
  /** Project-wide instruction files, passed through to opencode.json. */
  instructions: z.array(z.string()).default([]),
  run: z
    .object({
      concurrency: z.number().int().positive().default(2),
      timeoutMs: z.number().int().positive().default(30 * 60 * 1000),
    })
    .default({}),
});

export type Permission = z.infer<typeof PermissionSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type AgentStep = z.infer<typeof AgentStepSchema>;
export type LoopStep = z.infer<typeof LoopStepSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Pipeline = z.infer<typeof PipelineSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type Evaluation = z.infer<typeof EvalSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export function isLoopStep(step: Step): step is LoopStep {
  return "loop" in step;
}

/** Every step id in a pipeline, loop bodies included. */
export function allSteps(pipeline: Pipeline): AgentStep[] {
  return pipeline.steps.flatMap((step) => (isLoopStep(step) ? step.loop.body : [step]));
}
