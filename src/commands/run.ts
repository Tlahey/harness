import { loadWorkspace, requireRole, resolveModel } from "../config/load.ts";
import { buildArgs, quote, runAgent } from "../opencode/exec.ts";
import { c, log } from "../util/log.ts";

export interface RunRoleOptions {
  role: string;
  message: string;
  model?: string;
  dryRun?: boolean;
  continueSession?: boolean;
}

/** One-off invocation of a single role, outside of any pipeline. */
export async function runRoleCommand(opts: RunRoleOptions): Promise<number> {
  const ws = await loadWorkspace();
  const role = requireRole(ws, opts.role);
  const model = resolveModel(ws.config, opts.model ?? role.model);

  const runOptions = {
    binary: ws.config.opencode.binary,
    agent: role.name,
    model,
    message: opts.message,
    cwd: ws.root,
    env: ws.config.opencode.env,
    extraArgs: ws.config.opencode.args,
    continueSession: opts.continueSession,
    timeoutMs: ws.config.run.timeoutMs,
  };

  if (opts.dryRun) {
    console.log(quote([ws.config.opencode.binary, ...buildArgs(runOptions)]));
    return 0;
  }

  log.step(`${c.bold(role.name)} ${c.dim(`(${model})`)}`);
  const result = await runAgent({ ...runOptions, onChunk: (chunk) => process.stdout.write(chunk) });

  if (result.code !== 0) {
    log.error(`opencode exited with ${result.code}${result.timedOut ? " (timed out)" : ""}`);
    if (result.stderr.trim()) log.detail(result.stderr.trim());
  }
  return result.code;
}
