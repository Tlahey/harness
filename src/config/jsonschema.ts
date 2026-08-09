import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { EvalSchema, HarnessConfigSchema, PipelineSchema, RoleSchema } from "./schema.ts";

/** Generated JSON Schemas live here; the YAML files point at them with a modeline. */
export const SCHEMA_DIR = ".harness/schema";

function render(schema: ZodTypeAny, title: string, description: string): string {
  const json = zodToJsonSchema(schema, {
    // Editors handle a single self-contained document far better than $refs.
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;

  return `${JSON.stringify({ ...json, title, description }, null, 2)}\n`;
}

/**
 * Filename -> content. Generated from the same zod schemas the CLI validates against, so
 * editor hints and `harness validate` can never disagree.
 *
 * `name` is optional in every document: the file name supplies it.
 */
export function schemaFiles(): Record<string, string> {
  return {
    "role.json": render(
      RoleSchema.partial({ name: true }),
      "Harness role",
      "One agent: its prompt, model, tools, permissions and team.",
    ),
    "pipeline.json": render(
      PipelineSchema.partial({ name: true }),
      "Harness pipeline",
      "A DAG of steps, optionally containing loops, run by `harness pipeline run`.",
    ),
    "eval.json": render(
      EvalSchema.partial({ name: true }),
      "Harness evaluation",
      "A scenario replayed in an isolated worktree, then scored by assertions.",
    ),
    "config.json": render(
      HarnessConfigSchema,
      "Harness configuration",
      "Project-wide settings shared by every role and pipeline.",
    ),
  };
}

/** Writes the schemas outside of `sync`, so a freshly scaffolded project is valid immediately. */
export async function writeSchemas(root: string): Promise<string[]> {
  const dir = join(root, SCHEMA_DIR);
  await mkdir(dir, { recursive: true });

  const written: string[] = [];
  for (const [name, content] of Object.entries(schemaFiles())) {
    await writeFile(join(dir, name), content, "utf8");
    written.push(join(SCHEMA_DIR, name));
  }
  return written;
}
