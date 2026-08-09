import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { fail } from "../util/log.ts";

export interface ModelPlan {
  /** Model every role uses unless it was customised. */
  defaultModel: string;
  /** role name -> model id, for the roles the user chose to customise. */
  roleModels: Record<string, string>;
  /** opencode `provider` block, for local or self-hosted endpoints. */
  provider?: Record<string, unknown>;
}

/** `ollama/deepseek-r1:32b` -> `deepseek-r1`, so aliases stay readable in the YAML. */
export function aliasFor(modelId: string): string {
  const last = modelId.split("/").pop() ?? modelId;
  const alias = last
    .split(":")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return alias || "custom";
}

/**
 * Turns the chosen models into `models:` aliases: one `default`, plus one named alias per
 * distinct customised model. Roles then reference an alias, never a raw id, so swapping a
 * model stays a one-line change.
 */
export function buildAliases(plan: ModelPlan): { models: Record<string, string>; byRole: Record<string, string> } {
  const models: Record<string, string> = { default: plan.defaultModel };
  const byRole: Record<string, string> = {};
  const aliasOf = new Map<string, string>([[plan.defaultModel, "default"]]);

  for (const [role, modelId] of Object.entries(plan.roleModels)) {
    const existing = aliasOf.get(modelId);
    if (existing) {
      byRole[role] = existing;
      continue;
    }
    let alias = aliasFor(modelId);
    for (let n = 2; alias in models; n++) alias = `${aliasFor(modelId)}-${n}`;
    models[alias] = modelId;
    aliasOf.set(modelId, alias);
    byRole[role] = alias;
  }
  return { models, byRole };
}

function setWithComment(doc: Document, key: string, value: unknown, comment: string): void {
  doc.set(key, doc.createNode(value));
  const contents = doc.contents;
  if (!isMap(contents)) return;
  const pair = contents.items.find((item) => isScalar(item.key) && item.key.value === key);
  if (pair && isScalar(pair.key)) pair.key.commentBefore = comment;
}

/** Rewrites the scaffolded YAML in place, preserving its comments. */
export async function applyModelPlan(target: string, plan: ModelPlan): Promise<string[]> {
  const touched: string[] = [];
  const { models, byRole } = buildAliases(plan);

  const configPath = join(target, "harness.config.yaml");
  let configText: string;
  try {
    configText = await readFile(configPath, "utf8");
  } catch {
    fail(`No harness.config.yaml in ${target}; nothing to configure.`);
  }
  const config = parseDocument(configText);

  config.setIn(["defaults", "model"], "default");
  setWithComment(
    config,
    "models",
    models,
    " Aliases: a role points at `default` or at one of the aliases below.\n" +
      " Swapping a model everywhere is a one-line change here.\n" +
      " `opencode models` lists the ids your providers actually expose.",
  );

  if (plan.provider) {
    setWithComment(
      config,
      "provider",
      plan.provider,
      " Local / OpenAI-compatible provider, passed through verbatim to opencode.json.\n" +
        " Every model used has to be declared here or opencode will not resolve it.",
    );
  } else {
    config.delete("provider");
  }
  await writeFile(configPath, config.toString(), "utf8");
  touched.push("harness.config.yaml");

  const rolesDir = join(target, "roles");
  let entries: string[] = [];
  try {
    entries = (await readdir(rolesDir)).filter((f) => [".yaml", ".yml"].includes(extname(f)));
  } catch {
    return touched;
  }

  for (const entry of entries.sort()) {
    const file = join(rolesDir, entry);
    const doc = parseDocument(await readFile(file, "utf8"));
    const roleName = basename(entry, extname(entry));
    doc.set("model", byRole[roleName] ?? "default");
    await writeFile(file, doc.toString(), "utf8");
    touched.push(join("roles", entry));
  }

  return touched;
}

/** A model id must be `provider/model`: that is what opencode resolves. */
export function assertModelId(modelId: string): string {
  if (!modelId.includes("/")) {
    fail(`"${modelId}" is not a valid id. Expected provider/model, e.g. ollama/qwen3-coder:30b.`);
  }
  return modelId;
}
