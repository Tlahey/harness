import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkspace, type Workspace } from "../config/load.ts";
import { sync } from "../opencode/generate.ts";
import { isGitRepo } from "../util/git.ts";
import { c, log } from "../util/log.ts";
import { validateWorkspace } from "./validate.ts";

/**
 * Local and self-hosted endpoints fail late and cryptically inside opencode, so check them
 * here: is the server up, and does it actually serve the models the config declares?
 */
async function checkProviders(providers: Record<string, unknown>): Promise<number> {
  let failures = 0;

  for (const [name, raw] of Object.entries(providers)) {
    const provider = raw as { options?: { baseURL?: unknown; apiKey?: unknown }; models?: Record<string, unknown> };
    const baseURL = provider.options?.baseURL;
    if (typeof baseURL !== "string") continue;

    const url = `${baseURL.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {};
    if (typeof provider.options?.apiKey === "string") headers.Authorization = `Bearer ${provider.options.apiKey}`;

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (!response.ok) {
        log.error(`${name}: ${url} returned ${response.status}`);
        failures++;
        continue;
      }
      const body = (await response.json()) as { data?: { id?: string }[] };
      const served = new Set((body.data ?? []).map((model) => model.id).filter(Boolean));
      const declared = Object.keys(provider.models ?? {});
      const missing = declared.filter((id) => !served.has(id));

      if (missing.length > 0) {
        log.error(`${name}: declared but not served: ${missing.join(", ")}`);
        log.detail(`served: ${[...served].join(", ") || "(none)"}`);
        failures++;
      } else {
        log.ok(`${name} reachable (${served.size} model(s) served)`);
      }
    } catch {
      log.error(`${name}: ${baseURL} unreachable — is the local server running?`);
      failures++;
    }
  }
  return failures;
}

/** The sandbox is optional, so everything here warns rather than fails. */
async function checkSandbox(ws: Workspace): Promise<void> {
  if (process.env.HARNESS_SANDBOX === "1") log.ok("running in the dev container (HARNESS_SANDBOX=1)");
  else log.detail("outside the container: agents write straight to your machine");

  const skills = await readdir(join(ws.root, ".opencode/skill")).catch(() => [] as string[]);
  if (skills.length > 0) log.ok(`opencode skills: ${skills.join(", ")}`);
  else log.detail("no skill in .opencode/skill (agent-browser: see .devcontainer/setup.sh)");

  const chromium = spawnSync("bash", ["-lc", "command -v chromium || command -v chromium-browser || true"], {
    encoding: "utf8",
  });
  const browsers = await readdir(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/nonexistent").catch(() => [] as string[]);
  if (chromium.stdout?.trim() || browsers.some((entry) => entry.startsWith("chromium"))) log.ok("chromium available");
  else log.detail("no chromium found (npx playwright install chromium)");

  if (!isGitRepo(ws.root)) {
    log.warn("not a git repository: `harness eval` cannot isolate its runs, `improve` cannot roll back");
  }
}

/** Pre-flight: is this workspace actually able to run anything? */
export async function doctorCommand(): Promise<number> {
  const ws = await loadWorkspace();
  let failures = 0;

  const binary = ws.config.opencode.binary;
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    log.error(`\`${binary}\` is not runnable. Install opencode: https://opencode.ai`);
    failures++;
  } else {
    log.ok(`${binary} ${version.stdout.trim()}`);
  }

  failures += await checkProviders(ws.config.provider);
  await checkSandbox(ws);

  const errors = await validateWorkspace(ws);
  if (errors.length > 0) {
    for (const error of errors) log.error(error);
    failures += errors.length;
  } else {
    log.ok(`${ws.roles.size} role(s), ${ws.pipelines.size} pipeline(s), ${ws.evals.size} eval(s) valid`);
  }

  const pending = await sync(ws, { check: true });
  if (pending.written.length > 0 || pending.removed.length > 0) {
    log.warn(`opencode.json is stale; run ${c.cyan("harness sync")}`);
    failures++;
  } else {
    log.ok("opencode.json is up to date");
  }
  for (const file of pending.drifted) log.warn(`${file} was hand-edited and no longer matches its role`);

  return failures > 0 ? 1 : 0;
}
