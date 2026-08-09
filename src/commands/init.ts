import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { SCHEMA_DIR, writeSchemas } from "../config/jsonschema.ts";
import { applyModelPlan, assertModelId, type ModelPlan } from "../init/apply.ts";
import { buildProviderBlock, discoverModels, findPreset, PRESETS, type Preset } from "../init/presets.ts";
import { c, fail, log } from "../util/log.ts";
import { isInteractive, Prompter, type Choice } from "../util/prompt.ts";

const CUSTOM = "__custom__";
const KEEP_DEFAULT = "__default__";

export interface InitArgs {
  dir: string;
  force: boolean;
  /** Skip every question and use flags (or the template's own defaults). */
  yes: boolean;
  provider?: string;
  model?: string;
  /** role -> model id, from repeated --role-model flags. */
  roleModels: Record<string, string>;
  /** For local OpenAI-compatible servers. */
  baseUrl?: string;
  apiKey?: string;
}

/** `template/` at the root of this package, next to src/. */
function templateDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../template");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(
  from: string,
  to: string,
  force: boolean,
  report: { created: string[]; skipped: string[] },
  base = to,
): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest, force, report, base);
      continue;
    }
    const rel = relative(base, dest);
    if ((await exists(dest)) && !force) {
      report.skipped.push(rel);
      continue;
    }
    await copyFile(src, dest);
    report.created.push(rel);
  }
}

interface ScaffoldedRole {
  name: string;
  description: string;
}

async function readRoles(target: string): Promise<ScaffoldedRole[]> {
  const dir = join(target, "roles");
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((f) => [".yaml", ".yml"].includes(extname(f)));
  } catch {
    return [];
  }

  const roles: ScaffoldedRole[] = [];
  for (const entry of entries.sort()) {
    const doc = parseDocument(await readFile(join(dir, entry), "utf8"));
    roles.push({
      name: basename(entry, extname(entry)),
      description: String(doc.get("description") ?? ""),
    });
  }
  return roles;
}

interface Endpoint {
  baseURL: string;
  apiKey?: string;
}

interface Selection {
  preset: Preset;
  endpoint?: Endpoint;
  /** What the picker offers: discovered from the server when possible. */
  choices: Choice[];
}

function requirePreset(id: string): Preset {
  const preset = findPreset(id);
  if (!preset) fail(`Unknown provider "${id}". Valid values: ${PRESETS.map((p) => p.id).join(", ")}`);
  return preset;
}

/** Local servers are asked what they serve: a hardcoded list is wrong the moment you swap a model. */
async function resolveSelection(preset: Preset, args: InitArgs, prompter?: Prompter): Promise<Selection> {
  if (!preset.endpoint) return { preset, choices: preset.models };

  const baseURL =
    args.baseUrl ?? (prompter ? await prompter.text("Server URL:", preset.endpoint.defaultBaseURL) : preset.endpoint.defaultBaseURL);
  const apiKey =
    args.apiKey ??
    (prompter && preset.endpoint.askApiKey
      ? (await prompter.text("API key (leave empty if the server needs none):", "")) || undefined
      : undefined);

  try {
    const discovered = await discoverModels(baseURL, apiKey);
    log.ok(`${discovered.length} model(s) served by ${baseURL}`);
    return {
      preset,
      endpoint: { baseURL, apiKey },
      choices: discovered.map((id) => ({ value: `${preset.endpoint!.key}/${id}`, label: id })),
    };
  } catch (err) {
    log.warn(`${baseURL} unreachable (${(err as Error).message}) — falling back to static suggestions`);
    return { preset, endpoint: { baseURL, apiKey }, choices: preset.models };
  }
}

async function askModel(prompter: Prompter, question: string, choices: Choice[], extra: Choice[] = []): Promise<string> {
  const all = [...extra, ...choices, { value: CUSTOM, label: "other (type an id)" }];
  const answer = await prompter.select(question, all);
  if (answer !== CUSTOM) return answer;
  return assertModelId(await prompter.text("  model id (provider/model):"));
}

function buildPlan(selection: Selection, defaultModel: string, roleModels: Record<string, string>): ModelPlan {
  const allModels = [defaultModel, ...Object.values(roleModels)];
  const provider =
    selection.preset.endpoint && selection.endpoint
      ? buildProviderBlock(selection.preset.endpoint, selection.endpoint.baseURL, selection.endpoint.apiKey, allModels)
      : undefined;
  return { defaultModel, roleModels, provider };
}

/** Interactive model selection: one default for everybody, then optional per-role overrides. */
async function askPlan(roles: ScaffoldedRole[], args: InitArgs): Promise<{ plan: ModelPlan; preset: Preset }> {
  const prompter = new Prompter();
  try {
    const presetId =
      args.provider ??
      (await prompter.select(
        "Which model provider?",
        PRESETS.map((p) => ({ value: p.id, label: p.label, hint: p.hint })),
      ));
    const selection = await resolveSelection(requirePreset(presetId), args, prompter);

    const defaultModel = args.model
      ? assertModelId(args.model)
      : selection.choices.length === 0
        ? assertModelId(await prompter.text("Default model (provider/model):"))
        : await askModel(prompter, "Default model, used by every role:", selection.choices);

    const roleModels: Record<string, string> = { ...args.roleModels };
    const remaining = roles.filter((role) => !(role.name in roleModels));

    if (remaining.length > 0 && (await prompter.confirm("Customise the model of specific roles?", false))) {
      for (const role of remaining) {
        const choice = await askModel(prompter, `Model for ${c.bold(role.name)} — ${role.description}`, selection.choices, [
          { value: KEEP_DEFAULT, label: `keep the default (${defaultModel})` },
        ]);
        if (choice !== KEEP_DEFAULT) roleModels[role.name] = choice;
      }
    }

    return { plan: buildPlan(selection, defaultModel, roleModels), preset: selection.preset };
  } finally {
    prompter.close();
  }
}

export async function init(args: InitArgs): Promise<void> {
  const source = templateDir();
  if (!(await exists(source))) {
    fail(`Template not found at ${source}. Run \`harness init\` from a checkout of this repo.`);
  }

  const target = resolve(process.cwd(), args.dir);
  const report = { created: [] as string[], skipped: [] as string[] };
  await copyTree(source, target, args.force, report);

  for (const file of report.created) log.ok(`created ${file}`);
  for (const file of report.skipped) log.detail(`kept ${file} (--force to overwrite)`);

  // Written before anything else runs, so the `$schema` modelines in the YAML files
  // resolve the moment the editor opens them.
  const schemas = await writeSchemas(target);
  log.detail(`${schemas.length} JSON schemas written to ${SCHEMA_DIR}/`);

  const roles = await readRoles(target);
  for (const role of Object.keys(args.roleModels)) {
    if (!roles.some((r) => r.name === role)) {
      fail(`--role-model ${role}=…: unknown role. Available roles: ${roles.map((r) => r.name).join(", ")}`);
    }
  }

  const askable = isInteractive() && !args.yes;
  const flagged = Boolean(args.provider || args.model || args.baseUrl || Object.keys(args.roleModels).length > 0);
  let preset: Preset | null = null;
  let plan: ModelPlan | null = null;

  if (askable) {
    ({ plan, preset } = await askPlan(roles, args));
  } else if (flagged) {
    const selection = await resolveSelection(requirePreset(args.provider ?? presetOf(args.model ?? "")), args);
    preset = selection.preset;
    const defaultModel = args.model
      ? assertModelId(args.model)
      : (selection.choices[0]?.value ?? fail("Cannot determine a default model: pass --model"));
    for (const modelId of Object.values(args.roleModels)) assertModelId(modelId);
    plan = buildPlan(selection, defaultModel, args.roleModels);
  }

  if (plan) {
    const touched = await applyModelPlan(target, plan);
    log.info("");
    for (const file of touched) log.detail(`configured ${file}`);
    log.info("");
    for (const role of roles) {
      const model = plan.roleModels[role.name] ?? plan.defaultModel;
      const suffix = plan.roleModels[role.name] ? "" : c.dim(" (default)");
      log.info(`  ${c.bold(role.name.padEnd(12))} ${c.magenta(model)}${suffix}`);
    }
    if (preset && preset.setup.length > 0) {
      log.info("");
      log.info(c.bold("Before the first run:"));
      for (const step of preset.setup) log.info(`  - ${step}`);
    }
  } else {
    log.info("");
    log.detail("models left as they are; adjust `models:` in harness.config.yaml");
  }

  log.info("");
  log.info(`Harness scaffolded in ${c.bold(target)}. Next:`);
  log.info(`  1. ${c.cyan("harness sync")} — generate opencode.json and .opencode/prompt/`);
  log.info(`  2. ${c.cyan("harness doctor")} — check opencode, the config and local endpoints`);
  log.info(`  3. ${c.cyan('harness pipeline run feature --input task="…" --dry-run')}`);
}

/** Guesses the preset from a model id, so `--model ollama/…` implies the ollama provider. */
function presetOf(modelId: string): string {
  const provider = modelId.split("/")[0] ?? "";
  return findPreset(provider) ? provider : "custom";
}
