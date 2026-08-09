const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: paint("2"),
  bold: paint("1"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
};

/** Everything except command payloads goes to stderr, so stdout stays pipeable. */
export const log = {
  info: (msg: string) => console.error(msg),
  step: (msg: string) => console.error(`${c.cyan("›")} ${msg}`),
  ok: (msg: string) => console.error(`${c.green("✓")} ${msg}`),
  warn: (msg: string) => console.error(`${c.yellow("!")} ${msg}`),
  error: (msg: string) => console.error(`${c.red("✗")} ${msg}`),
  detail: (msg: string) => console.error(c.dim(`  ${msg}`)),
};

export class HarnessError extends Error {}

/** Thrown for user-facing problems; the CLI prints these without a stack trace. */
export function fail(msg: string): never {
  throw new HarnessError(msg);
}
