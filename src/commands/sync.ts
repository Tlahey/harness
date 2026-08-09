import { loadWorkspace } from "../config/load.ts";
import { sync } from "../opencode/generate.ts";
import { c, log } from "../util/log.ts";

export async function syncCommand(opts: { check: boolean; force: boolean }): Promise<number> {
  const ws = await loadWorkspace();
  const result = await sync(ws, { check: opts.check, force: opts.force });

  for (const file of result.written) log.ok(`${opts.check ? "would write" : "wrote"} ${file}`);
  for (const file of result.removed) log.ok(`${opts.check ? "would remove" : "removed"} ${file}`);
  for (const file of result.drifted) log.warn(`${file} was edited by hand; left alone (use --force to overwrite)`);
  if (result.unchanged.length > 0) log.detail(`${result.unchanged.length} file(s) already up to date`);

  if (opts.check && (result.written.length > 0 || result.removed.length > 0)) {
    log.error(`opencode config is out of date. Run ${c.cyan("harness sync")}.`);
    return 1;
  }
  return result.drifted.length > 0 && !opts.check ? 1 : 0;
}
