import { loadWorkspace, requireEval } from "../config/load.ts";
import { readBaseline, runEvaluation, writeBaseline, type EvaluationResult } from "../core/evaluate.ts";
import { c, log } from "../util/log.ts";

export interface EvalArgs {
  names?: string[];
  inPlace?: boolean;
  keep?: boolean;
  verbose?: boolean;
  saveBaseline?: boolean;
}

const percent = (score: number) => `${Math.round(score * 100)}%`;

export async function listEvals(): Promise<void> {
  const ws = await loadWorkspace();
  if (ws.evals.size === 0) {
    log.warn(`No evals found in ${ws.config.paths.evals}`);
    return;
  }
  const baseline = await readBaseline(ws);
  const width = Math.max(...[...ws.evals.keys()].map((n) => n.length));
  for (const evaluation of ws.evals.values()) {
    const known = baseline?.scores[evaluation.name];
    const score = known === undefined ? c.dim("never measured") : c.magenta(percent(known));
    console.log(
      `${c.bold(evaluation.name.padEnd(width))}  ${evaluation.pipeline.padEnd(12)} ${score.padEnd(20)} ` +
        c.dim(evaluation.description ?? ""),
    );
  }
}

function printResult(result: EvaluationResult, baseline: number | undefined): void {
  const delta =
    baseline === undefined
      ? ""
      : result.score > baseline
        ? c.green(` (+${percent(result.score - baseline)})`)
        : result.score < baseline
          ? c.red(` (−${percent(baseline - result.score)})`)
          : c.dim(" (=)");

  log.info("");
  log.info(`${c.bold(result.evaluation)} ${percent(result.score)}${delta} — ${result.passed}/${result.total} assertions`);
  for (const assertion of result.assertions) {
    const icon = assertion.passed ? c.green("✓") : c.red("✗");
    log.info(`  ${icon} ${assertion.label} ${c.dim(assertion.detail)}`);
  }
  if (result.pipelineStatus === "failed") log.warn("the pipeline itself failed");
}

export async function evalCommand(args: EvalArgs): Promise<number> {
  const ws = await loadWorkspace();
  const names = args.names?.length ? args.names : [...ws.evals.keys()];
  if (names.length === 0) {
    log.warn(`No evals found in ${ws.config.paths.evals}`);
    return 0;
  }

  const baseline = await readBaseline(ws);
  const results: EvaluationResult[] = [];

  // Sequential on purpose: each eval owns a worktree and may run a build.
  for (const name of names) {
    const evaluation = requireEval(ws, name);
    const result = await runEvaluation(ws, evaluation, {
      inPlace: args.inPlace,
      keep: args.keep,
      verbose: args.verbose,
    });
    results.push(result);
    printResult(result, baseline?.scores[name]);
  }

  if (results.length > 1) {
    const average = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    log.info("");
    log.info(`${c.bold("average")} ${percent(average)} across ${results.length} eval(s)`);
  }

  if (args.saveBaseline) {
    const saved = await writeBaseline(ws, results);
    log.ok(`baseline saved (${Object.keys(saved.scores).length} eval(s))`);
  }

  return results.every((r) => r.score === 1) ? 0 : 1;
}
