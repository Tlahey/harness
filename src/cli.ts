#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { doctorCommand } from "./commands/doctor.ts";
import { evalCommand, listEvals } from "./commands/eval.ts";
import { improveCommand } from "./commands/improve.ts";
import { init } from "./commands/init.ts";
import { addMemoryCommand, listMemoryCommand, showMemoryCommand, syncMemoryCommand } from "./commands/memory.ts";
import { listPipelines, runPipelineCommand, showPipeline } from "./commands/pipelines.ts";
import { reportCommand } from "./commands/report.ts";
import { listRoles, showRole } from "./commands/roles.ts";
import { runRoleCommand } from "./commands/run.ts";
import { listRuns, showRun } from "./commands/runs.ts";
import { listStateCommand, setStateCommand, unsetStateCommand } from "./commands/state.ts";
import { syncCommand } from "./commands/sync.ts";
import { validateCommand } from "./commands/validate.ts";
import { HarnessError, c, fail, log } from "./util/log.ts";

const HELP = `${c.bold("harness")} — declarative multi-role agent harness on top of opencode

${c.bold("Usage")}
  harness <command> [options]

${c.bold("Setup")}
  init [dir]                     Scaffold the project and pick models (interactive)
  sync [--check] [--force]       Generate opencode.json (permission, provider, agent) + prompts
  validate                       Schemas, DAG, loops, models, placeholders, evals
  doctor                         opencode, local endpoints, sandbox, sync state

${c.bold("Definition")}
  roles                          List roles and the model each one uses
  roles show <role> [--prompt]   Inspect a role, or print its full system prompt
  pipeline                       List pipelines
  pipeline show <name>           Inputs and steps of a pipeline

${c.bold("Execution")}
  pipeline run <name> [options]  Run a pipeline
  run <role> [message]           Run one role once (message may come from stdin)

${c.bold("Memory and state")}
  memory                         List what the project has learned
  memory add <name> -d <desc>    Add an entry (body on stdin)
  memory show <name> | sync      Print an entry | rebuild the index
  state [set <key> <value>]      Read or write shared state, readable as {{ state.key }}

${c.bold("Observability and evaluation")}
  runs [show <run-id>]           Run history and details
  report [run-id] [--all]        Timeline of a run, or per-role statistics
  eval [name…] [--save-baseline] Run evals in an isolated worktree and score them
  improve [--apply] [--eval]     Propose (or apply) prompt fixes, measured and reversible

${c.bold("Init options")}
  --provider <id>                ollama | lmstudio | openai-compatible | openrouter |
                                 anthropic | custom
  --base-url <url>               Local server: harness lists the models it serves
  --api-key <key>                Local server key, when one is required
  --model <provider/model>       Default model for every role
  --role-model <role>=<model>    Override a single role; repeatable
  --yes                          No questions: use the flags, or leave the template as is

${c.bold("Pipeline run options")}
  --input k=v                    Pipeline input; repeatable
  --dry-run                      Print the opencode commands without running them
  --concurrency <n>              How many steps may run at once
  --from <step> / --only <step>  Replay part of the graph
  --resume <run-id>              Reuse a previous run's directory and outputs
  --verbose                      Stream each agent's output as it happens

${c.bold("Eval and improve options")}
  --in-place                     Do not isolate in a worktree (writes in your tree)
  --keep                         Keep the worktree for inspection
  --save-baseline                Lock in the current scores as the reference
  --apply                        improve: apply instead of proposing
  --eval                         improve: re-evaluate afterwards, roll back on regression

${c.bold("Examples")}
  harness init --provider ollama --model ollama/qwen3-coder:30b --yes
  harness pipeline run feature --input task="add a /health endpoint" --dry-run
  harness eval --save-baseline && harness improve --apply --eval
`;

async function version(): Promise<string> {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(await readFile(file, "utf8")) as { version: string };
  return pkg.version;
}

function parseKeyValues(entries: string[], flag: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index <= 0) fail(`${flag} expects key=value, got "${entry}"`);
    parsed[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return parsed;
}

/** Lets `harness run developer < prompt.md` and `harness memory add x < note.md` work. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      force: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      prompt: { type: "boolean", default: false },
      continue: { type: "boolean", short: "c", default: false },
      model: { type: "string", short: "m" },
      yes: { type: "boolean", short: "y", default: false },
      provider: { type: "string" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      "role-model": { type: "string", multiple: true, default: [] },
      input: { type: "string", multiple: true, default: [] },
      concurrency: { type: "string" },
      from: { type: "string" },
      only: { type: "string", multiple: true, default: [] },
      resume: { type: "string" },
      all: { type: "boolean", default: false },
      limit: { type: "string" },
      description: { type: "string", short: "d" },
      type: { type: "string" },
      "in-place": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      "save-baseline": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      eval: { type: "boolean", default: false },
      runs: { type: "string" },
    },
  });

  const [command, ...rest] = positionals;

  if (values.version) {
    console.log(await version());
    return 0;
  }
  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  const positiveInt = (raw: string | undefined, flag: string): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) fail(`${flag} expects a positive integer, got "${raw}"`);
    return value;
  };

  switch (command) {
    case "init":
      await init({
        dir: rest[0] ?? ".",
        force: values.force ?? false,
        yes: values.yes ?? false,
        provider: values.provider,
        model: values.model,
        baseUrl: values["base-url"],
        apiKey: values["api-key"],
        roleModels: parseKeyValues(values["role-model"] ?? [], "--role-model"),
      });
      return 0;

    case "sync":
      return await syncCommand({ check: values.check ?? false, force: values.force ?? false });

    case "validate":
      return await validateCommand();

    case "doctor":
      return await doctorCommand();

    case "role":
    case "roles": {
      const [sub, name] = rest;
      if (!sub || sub === "list") {
        await listRoles();
        return 0;
      }
      if (sub === "show") {
        if (!name) fail("Usage: harness roles show <role> [--prompt]");
        await showRole(name, { prompt: values.prompt ?? false });
        return 0;
      }
      // `harness roles architect` is the obvious shorthand; accept it.
      await showRole(sub, { prompt: values.prompt ?? false });
      return 0;
    }

    case "pipeline":
    case "pipelines": {
      const [sub, name] = rest;
      if (!sub || sub === "list") {
        await listPipelines();
        return 0;
      }
      if (sub === "show") {
        if (!name) fail("Usage: harness pipeline show <name>");
        await showPipeline(name);
        return 0;
      }
      if (sub === "run") {
        if (!name) fail("Usage: harness pipeline run <name> --input key=value");
        return await runPipelineCommand({
          name,
          inputs: parseKeyValues(values.input ?? [], "--input"),
          dryRun: values["dry-run"],
          concurrency: positiveInt(values.concurrency, "--concurrency"),
          from: values.from,
          only: (values.only ?? []).length > 0 ? values.only : undefined,
          resume: values.resume,
          verbose: values.verbose,
        });
      }
      fail(`Unknown pipeline subcommand "${sub}"`);
      break;
    }

    case "run": {
      const [role, ...message] = rest;
      if (!role) fail('Usage: harness run <role> "<message>"');
      const text = message.join(" ").trim() || (await readStdin());
      if (!text) fail("Nothing to send. Pass a message argument or pipe it on stdin.");
      return await runRoleCommand({
        role,
        message: text,
        model: values.model,
        dryRun: values["dry-run"],
        continueSession: values.continue,
      });
    }

    case "runs": {
      const [sub, id] = rest;
      if (!sub || sub === "list") {
        await listRuns();
        return 0;
      }
      if (sub === "show") {
        if (!id) fail("Usage: harness runs show <run-id>");
        await showRun(id);
        return 0;
      }
      await showRun(sub);
      return 0;
    }

    case "report":
      return await reportCommand({
        runId: rest[0],
        all: values.all,
        limit: positiveInt(values.limit, "--limit"),
      });

    case "eval": {
      const [sub, ...names] = rest;
      if (sub === "list") {
        await listEvals();
        return 0;
      }
      return await evalCommand({
        names: sub ? [sub, ...names] : undefined,
        inPlace: values["in-place"],
        keep: values.keep,
        verbose: values.verbose,
        saveBaseline: values["save-baseline"],
      });
    }

    case "improve":
      return await improveCommand({
        apply: values.apply,
        evaluate: values.eval,
        runs: positiveInt(values.runs, "--runs"),
        dryRun: values["dry-run"],
        verbose: values.verbose,
      });

    case "memory": {
      const [sub, name] = rest;
      if (!sub || sub === "list") {
        await listMemoryCommand();
        return 0;
      }
      if (sub === "sync") {
        await syncMemoryCommand();
        return 0;
      }
      if (sub === "show") {
        if (!name) fail("Usage: harness memory show <name>");
        await showMemoryCommand(name);
        return 0;
      }
      if (sub === "add") {
        if (!name) fail("Usage: harness memory add <name> -d \"description\" < note.md");
        if (!values.description) fail("--description is required: it is what other roles will read.");
        await addMemoryCommand({
          name,
          description: values.description,
          type: values.type ?? "note",
          body: await readStdin(),
        });
        return 0;
      }
      fail(`Unknown memory subcommand "${sub}"`);
      break;
    }

    case "state": {
      const [sub, key, ...value] = rest;
      if (!sub || sub === "list") {
        await listStateCommand();
        return 0;
      }
      if (sub === "set") {
        if (!key || value.length === 0) fail("Usage: harness state set <key> <value>");
        await setStateCommand(key, value.join(" "));
        return 0;
      }
      if (sub === "unset") {
        if (!key) fail("Usage: harness state unset <key>");
        await unsetStateCommand(key);
        return 0;
      }
      fail(`Unknown state subcommand "${sub}"`);
      break;
    }

    default:
      fail(`Unknown command "${command}". Run \`harness --help\`.`);
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof HarnessError) {
    log.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
