import { createInterface, type Interface } from "node:readline/promises";
import { c } from "./log.ts";

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Numbered prompts on stderr, so `harness init` stays usable when its output is piped.
 * Deliberately no raw-mode arrow-key menu: this has to work over ssh and in CI logs.
 */
export class Prompter {
  private rl: Interface | null = null;

  private get input(): Interface {
    this.rl ??= createInterface({ input: process.stdin, output: process.stderr });
    return this.rl;
  }

  async select(question: string, choices: Choice[], defaultIndex = 0): Promise<string> {
    if (choices.length === 0) throw new Error(`select("${question}") called with no choices`);
    process.stderr.write(`\n${c.bold(question)}\n`);
    choices.forEach((choice, index) => {
      const hint = choice.hint ? c.dim(` — ${choice.hint}`) : "";
      process.stderr.write(`  ${c.cyan(String(index + 1))}. ${choice.label}${hint}\n`);
    });

    for (;;) {
      const answer = (await this.input.question(c.dim(`[1-${choices.length}, default ${defaultIndex + 1}] `))).trim();
      if (answer === "") return choices[defaultIndex]!.value;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index]!.value;
      process.stderr.write(c.yellow(`  Enter a number between 1 and ${choices.length}.\n`));
    }
  }

  async text(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? c.dim(` [${defaultValue}] `) : " ";
    for (;;) {
      const answer = (await this.input.question(`${c.bold(question)}${suffix}`)).trim();
      if (answer) return answer;
      if (defaultValue !== undefined) return defaultValue;
    }
  }

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
    const answer = (await this.input.question(`\n${c.bold(question)}${c.dim(suffix)}`)).trim().toLowerCase();
    if (answer === "") return defaultValue;
    return ["y", "yes"].includes(answer);
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }
}
