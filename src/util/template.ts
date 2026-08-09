import { fail } from "./log.ts";

export type Scope = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g;

function resolve(scope: Scope, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, scope);
}

function flatten(value: unknown, prefix = "", out: string[] = []): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.push(prefix);
  }
  return out;
}

/**
 * Replaces `{{ dotted.path }}` from `scope`. Unknown or non-scalar paths are a hard
 * error: a silently empty placeholder in a prompt is very expensive to debug.
 */
export function interpolate(template: string, scope: Scope, where: string): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = resolve(scope, path);
    if (value === undefined || value === null) {
      fail(
        `Unknown placeholder {{ ${path} }} in ${where}.\n` +
          `  Available: ${flatten(scope).sort().join(", ") || "(nothing)"}`,
      );
    }
    if (typeof value === "object") {
      fail(`Placeholder {{ ${path} }} in ${where} resolves to an object, not text.`);
    }
    return String(value);
  });
}

/** Placeholders referenced by a template, for validation before anything runs. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}
