# CLI reference

Every command resolves its workspace by walking up from the current directory looking for
`harness.config.yaml`, the way git looks for `.git`.

Diagnostics go to stderr, payloads to stdout — so `harness roles show x --prompt > file`
gives you the prompt and nothing else.

## Setup

### `harness init [dir]`

Copies the template and configures the models. Interactive by default: provider → default
model → optionally a model per role.

| Flag | Effect |
|---|---|
| `--provider <id>` | `ollama`, `lmstudio`, `openai-compatible`, `openrouter`, `anthropic`, `custom` |
| `--base-url <url>` | Local server; harness queries it and offers the models it serves |
| `--api-key <key>` | Local server key, when one is required |
| `--model <provider/model>` | Default model for every role |
| `--role-model <role>=<model>` | Override one role; repeatable |
| `--yes` | No questions: use the flags, or leave the template as it is |
| `--force` | Overwrite files that already exist |

```bash
harness init                                     # interactive
harness init --provider openai-compatible --base-url http://127.0.0.1:8000/v1
harness init --yes --provider ollama --model ollama/qwen3-coder:30b \
             --role-model architect=ollama/deepseek-r1:32b
```

With `--yes` and no other flag, the template's own model settings are left untouched.

### `harness sync [--check] [--force]`

Generates `opencode.json`, `.opencode/prompt/*.md` and `.harness/schema/*.json`, then
records their fingerprints.

- `--check` writes nothing and exits 1 if anything is stale. Use it in CI.
- `--force` overwrites files that were edited by hand (reported as *drift* otherwise).

### `harness validate`

Static checks, before anything costs a token: schemas, unknown roles, DAG cycles, loop
bodies, `subagent` roles used as steps, model aliases, missing instruction files,
placeholders that no dependency provides, evals pointing at unknown pipelines or steps.

### `harness doctor`

`validate`, plus the environment: is the `opencode` binary runnable, is every local
provider endpoint reachable, does it serve the declared models, is there a browser and a
skill directory, is this a git repository, is `opencode.json` up to date.

## Definition

### `harness roles [list]` · `harness roles show <role> [--prompt]`

Lists roles with their resolved model, or shows one role's settings. `--prompt` prints the
final assembled system prompt — role prompt, instruction files, team, memory index,
deliverables. This is what the model actually receives.

### `harness pipeline [list]` · `harness pipeline show <name>`

`show` renders the steps, their dependencies and their models, with loop bodies indented
under their loop.

## Execution

### `harness pipeline run <name> [options]`

| Flag | Effect |
|---|---|
| `--input k=v` | Pipeline input; repeatable |
| `--dry-run` | Print the `opencode run` commands, execute nothing |
| `--concurrency <n>` | Override how many steps run at once |
| `--from <step>` | Run this step and everything downstream of it |
| `--only <step>` | Run only this step; repeatable |
| `--resume <run-id>` | Reuse a previous run's directory and its successful outputs |
| `--verbose` | Stream each agent's output as it happens |

Exit code 1 if any step failed.

```bash
harness pipeline run feature --input task="add a /health endpoint" --dry-run
harness pipeline run feature --resume feature-2026-08-09T21-01-59 --from implement
```

`--dry-run` is the cheapest way to check a pipeline: it resolves every placeholder and
prints the exact commands, without spending anything.

### `harness run <role> [message]`

One role, once, outside any pipeline. The message can come from stdin:

```bash
harness run reviewer "review the uncommitted changes"
harness run developer < task.md
harness run architect -m ollama/deepseek-r1:32b "design the cache layer"
```

`--dry-run` prints the command; `-c` continues the role's most recent opencode session.

## Memory and state

```bash
harness memory                                   # list entries
harness memory show stack-bun
harness memory sync                              # rebuild MEMORY.md
echo "..." | harness memory add slug -d "one line" --type convention

harness state                                    # list keys
harness state set sprint 12
harness state unset sprint
```

`--type` is free-form; the template uses `convention`, `decision`, `failure`,
`preference`. The index groups by type.

## Observability

### `harness runs [show <run-id>]`

History of runs with their status, or the manifest of one run: per-step model, duration,
exit code, transcript path, missing deliverables, exact command.

### `harness report [run-id] [--all] [--limit <n>]`

Without arguments, the timeline of the most recent run, reconstructed from
`events.jsonl` — including loop iterations and whether the condition was met.

`--all` aggregates the last runs per role: how many times it ran, how often it failed, how
many retries, how many deliverables it forgot, average duration. That table is the input
to `harness improve`.

## Evaluation

### `harness eval [name…] [options]`

Replays each scenario in an isolated git worktree and scores the assertions.

| Flag | Effect |
|---|---|
| `--save-baseline` | Record the resulting scores as the reference |
| `--in-place` | Do not isolate; agents write into your working tree |
| `--keep` | Keep the worktree afterwards, to inspect what was produced |
| `--verbose` | Stream agent output |

`harness eval list` shows the scenarios and their last known score. Exit code 1 unless
every eval scores 100%.

### `harness improve [options]`

Builds a briefing from recent runs, eval results and memory, then runs the `improver` role
against it.

| Flag | Effect |
|---|---|
| *(none)* | Propose only: writes a proposal, changes nothing |
| `--apply` | Let the improver edit `improve.scope`, then validate and diff |
| `--eval` | Re-run the evals afterwards; roll back on regression |
| `--runs <n>` | How many past runs to include in the briefing (default 10) |
| `--dry-run` | Print the prompt that would be sent |

See [evaluation.md](evaluation.md) for the loop and its guardrails.

## Exit codes

`0` success · `1` a step, assertion, validation or check failed. Errors meant for you are
printed as one line without a stack trace; anything else is a bug and crashes loudly.
