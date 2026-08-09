import { spawn } from "node:child_process";
import { fail } from "../util/log.ts";

export interface RunOptions {
  binary: string;
  agent: string;
  model: string;
  message: string;
  cwd: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  /** Resume the most recent opencode session instead of opening a new one. */
  continueSession?: boolean;
  timeoutMs?: number;
  /** Called with raw stdout chunks so callers can stream progress. */
  onChunk?: (chunk: string) => void;
}

export interface RunResult {
  command: string[];
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function buildArgs(opts: RunOptions): string[] {
  const args = ["run", "--agent", opts.agent, "--model", opts.model];
  if (opts.continueSession) args.push("--continue");
  args.push(...(opts.extraArgs ?? []));
  args.push(opts.message);
  return args;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const args = buildArgs(opts);
  const command = [opts.binary, ...args];
  const startedAt = Date.now();

  return await new Promise<RunResult>((resolvePromise) => {
    const child = spawn(opts.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate if the agent ignores the polite request.
          setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
        }, opts.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      opts.onChunk?.(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fail(
          `Could not find the \`${opts.binary}\` executable.\n` +
            `  Install it (https://opencode.ai) or set \`opencode.binary\` in harness.config.yaml.`,
        );
      }
      resolvePromise({
        command,
        code: 1,
        stdout,
        stderr: `${stderr}${err.message}`,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        command,
        code: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/** Shell-ish rendering of a command, for --dry-run output only. */
export function quote(command: string[]): string {
  return command
    .map((part) => (/^[\w@/:=.,-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}
