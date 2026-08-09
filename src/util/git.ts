import { spawnSync } from "node:child_process";

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

export function currentRef(root: string): string {
  const named = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return named.ok && named.stdout !== "HEAD" ? named.stdout : git(root, ["rev-parse", "HEAD"]).stdout;
}

export function hasUncommittedChanges(root: string): boolean {
  return git(root, ["status", "--porcelain"]).stdout.length > 0;
}

/**
 * A detached worktree at HEAD: evals run agents that write files, and they must not do
 * that in the directory you are working in.
 */
export function addWorktree(root: string, path: string): { ok: boolean; error?: string } {
  const result = git(root, ["worktree", "add", "--detach", path, "HEAD"]);
  return result.ok ? { ok: true } : { ok: false, error: result.stderr || result.stdout };
}

export function removeWorktree(root: string, path: string): void {
  git(root, ["worktree", "remove", "--force", path]);
}

export function diffFiles(root: string, paths: string[]): string {
  return git(root, ["diff", "--", ...paths]).stdout;
}

export function restoreFiles(root: string, paths: string[]): boolean {
  return git(root, ["checkout", "--", ...paths]).ok;
}
