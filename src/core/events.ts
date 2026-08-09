import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HarnessEvent =
  | { type: "run_start"; runId: string; pipeline: string; inputs: Record<string, string> }
  | { type: "step_start"; runId: string; stepId: string; role: string; model: string; iteration?: number }
  | {
      type: "step_end";
      runId: string;
      stepId: string;
      status: string;
      exitCode: number | null;
      durationMs: number;
      attempts: number;
      missingOutputs: string[];
      iteration?: number;
    }
  | { type: "loop_iteration"; runId: string; loopId: string; iteration: number; matched: boolean }
  | { type: "run_end"; runId: string; status: string; durationMs: number }
  | { type: "eval_result"; evaluation: string; score: number; passed: number; total: number };

export type StampedEvent = HarnessEvent & { at: string };

/**
 * Append-only JSONL. One line per fact, never rewritten: a run that crashes still leaves a
 * readable trace, which a manifest written at the end does not.
 */
export class EventLog {
  constructor(private readonly file: string) {}

  async append(event: HarnessEvent): Promise<void> {
    const stamped: StampedEvent = { ...event, at: new Date().toISOString() };
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(stamped)}\n`, "utf8");
  }

  static async read(file: string): Promise<StampedEvent[]> {
    try {
      const raw = await readFile(file, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as StampedEvent];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
}

/** A no-op log, so dry runs and one-off role invocations share the same code path. */
export class NullEventLog extends EventLog {
  constructor() {
    super("");
  }
  override async append(): Promise<void> {}
}
