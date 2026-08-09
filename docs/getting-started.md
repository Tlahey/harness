# Getting started

From an empty machine to a pipeline that runs, then a worked example you can copy.

- [Requirements](#requirements)
- [Install](#install)
- [Three ways to run the CLI](#three-ways-to-run-the-cli)
- [Point it at a model](#point-it-at-a-model)
- [First run](#first-run)
- [Worked example: a smoke pipeline](#worked-example-a-smoke-pipeline)
- [Worked example: the feature pipeline](#worked-example-the-feature-pipeline)
- [Using the harness on an existing project](#using-the-harness-on-an-existing-project)
- [Troubleshooting](#troubleshooting)

## Requirements

| Tool | Why | Check |
|---|---|---|
| [Bun](https://bun.sh) ≥ 1.1 | runs the CLI | `bun --version` |
| [opencode](https://opencode.ai) | runs the agents | `opencode --version` |
| git | eval isolation and `improve` rollback | `git --version` |
| A model | hosted provider or a local server | `opencode models` |

```bash
curl -fsSL https://bun.sh/install | bash     # Bun
npm i -g opencode-ai@latest                  # opencode
```

Everything below also works inside the dev container, which installs all of this for you —
see [sandbox.md](sandbox.md).

## Install

```bash
git clone git@github.com:Tlahey/hardess.git
cd hardess
bun install
bun run typecheck    # optional, ~2s
```

## Three ways to run the CLI

**From the repo, no install.** Fine while you are exploring:

```bash
bun run harness --help
bun run harness init
```

**Linked globally.** This is what you want day to day — `harness` becomes a real command
anywhere on the machine, still pointing at your checkout, so edits to `src/` take effect
immediately:

```bash
bun link              # inside the repo, once
harness --help        # from anywhere
```

To undo it: `bun unlink` from the repo.

**Compiled to a single binary.** Useful for CI or a machine without Bun:

```bash
bun run build         # -> dist/harness
./dist/harness --help
```

> The compiled binary cannot run `harness init`: it copies files from `template/`, which
> lives in the repo. Scaffold from a checkout, then use the binary for everything else.

The rest of this page writes `harness`; substitute `bun run harness` if you skipped
`bun link`.

## Point it at a model

`harness init` asks three questions — provider, default model, and whether any role needs
a different one. It writes the answers into `harness.config.yaml`.

### Hosted provider

```bash
harness init my-project --provider anthropic --model anthropic/claude-sonnet-4-5 --yes
opencode auth login
```

### Local server (Ollama, LM Studio, oMLX, vLLM, LiteLLM…)

opencode does not know local servers natively, so harness asks yours what it serves and
writes the provider block for you:

```bash
harness init my-project --provider openai-compatible \
  --base-url http://127.0.0.1:8000/v1 --api-key admin
```

```
✓ 15 model(s) served by http://127.0.0.1:8000/v1
```

Run it without `--yes` and you get a picker listing those 15 models, then the option to
give a specific role a different one.

Ollama has its own preset with the usual default URL:

```bash
harness init my-project --provider ollama --model ollama/qwen3-coder:30b --yes
```

### Then, always

```bash
cd my-project
harness sync      # generate opencode.json and the system prompts
harness doctor    # verify everything before spending a token
```

`doctor` on a healthy local setup:

```
✓ opencode 1.17.15
✓ local reachable (15 model(s) served)
  outside the container: agents write straight to your machine
✓ 7 role(s), 1 pipeline(s), 1 eval(s) valid
✓ opencode.json is up to date
```

## First run

Always dry-run first. It resolves every placeholder and prints the exact commands without
spending anything:

```bash
harness pipeline run feature --input task="add a /health endpoint" --dry-run
```

```
› design (architect · local/Qwen3-Coder-Next-MLX-8bit)
  opencode run --agent architect --model local/Qwen3-Coder-Next-MLX-8bit 'Feature request:
add a /health endpoint

Produce the technical design and write it to docs/design/latest.md.'
› implement (developer · local/Qwen3-Coder-Next-MLX-8bit)
  ...
↻ verify — until /VERDICT:\s*approved/ (max 3)
› [1/3] review (reviewer · local/Qwen3-Coder-Next-MLX-8bit)
```

If a placeholder is wrong, you find out here rather than four agents in.

## Worked example: a smoke pipeline

Before spending real time on the `feature` pipeline, this one exercises the engine — DAG,
loop, interpolation, tracing — with two cheap calls. Drop it in `pipelines/smoke.yaml`:

```yaml
# yaml-language-server: $schema=../.harness/schema/pipeline.json
description: Smoke test for the engine — produces no code, just plumbing.

inputs:
  - name: word
    required: false
    default: ok

steps:
  - id: first
    role: judge
    prompt: |
      Do not verify anything. The password is "{{ input.word }}".
      Answer with only: VERDICT: pass

  - id: loopy
    needs: [first]
    loop:
      until: "VERDICT:\\s*pass"
      check: again
      max: 2
      body:
        - id: again
          role: judge
          prompt: |
            Iteration {{ loop.iteration }} of {{ loop.max }}.
            The previous step answered: {{ steps.first.output }}
            Do not verify anything. Answer with only: VERDICT: pass
```

```bash
harness validate                # catches placeholder and DAG mistakes
harness pipeline run smoke
```

Real output, against a local 8-bit Qwen3-Coder:

```
› first (judge · local/Qwen3-Coder-Next-MLX-8bit)
✓ first in 16s

↻ loopy — until /VERDICT:\s*pass/ (max 2)
› [1/2] again (judge · local/Qwen3-Coder-Next-MLX-8bit)
✓ again in 36s
✓ loopy: condition met on iteration 1

run smoke-2026-08-09T21-01-59
  ✓ first        judge        16s
  ✓ loopy        loop         36s
  ✓ again        judge        36s
  transcripts: .harness/runs/smoke-2026-08-09T21-01-59/
```

Then read the traces:

```bash
harness report
```

```
smoke-2026-08-09T21-01-59 (smoke) — success
2026-08-09T21:01:59.322Z → 2026-08-09T21:02:51.792Z  ·  88.6s of agent time

  21:02:15 ✓ first 16.3s
  21:02:51 ✓ again [1] 36.2s
  21:02:51 ↻ loopy iteration 1 — condition met
```

Two things this proves in under a minute: the loop exits as soon as the checked step
matches, and `{{ steps.first.output }}` really carried the previous answer forward.

## Worked example: the feature pipeline

This is the one that writes code. It runs five agents and a loop, so expect minutes, not
seconds.

```bash
harness pipeline run feature \
  --input task="Add a GET /health endpoint returning {\"status\":\"ok\"} and its test" \
  --verbose
```

What happens:

1. **design** — the architect writes `docs/design/latest.md`. It has `bash: deny` and no
   `patch` tool: it cannot start coding even if it wants to.
2. **implement** — the developer reads that design and writes the code, then runs the build
   and existing tests.
3. **verify** — a loop, up to three times:
   - **review** — the reviewer reads `git diff` and ends with `VERDICT: approved` or
     `changes-requested`. It cannot edit source files, only write its report.
   - if approved, the loop stops here — `test` and `fix` do not run;
   - **test** — the tester writes and runs tests, reports the real output;
   - **fix** — the developer addresses both reports and re-runs the tests.

Inspect afterwards:

```bash
harness runs                                   # history
harness report                                 # timeline of the last run
harness report --all                           # per-role failure and retry rates
cat .harness/runs/feature-*/review-1.md        # what the reviewer actually said
```

Replay part of it without redoing the expensive steps:

```bash
harness pipeline run feature --resume feature-2026-08-09T21-30-00 --from implement
```

### Score it, then improve

```bash
git add -A && git commit -m "wip"     # evals start from HEAD
harness eval --save-baseline          # runs evals/health-endpoint.yaml in a worktree
harness improve                       # proposal only, changes nothing
harness improve --apply --eval        # applies, re-evaluates, rolls back on regression
```

The full loop and its guardrails are in [evaluation.md](evaluation.md).

## Using the harness on an existing project

`harness init .` inside your repo copies the harness files alongside your code. It never
overwrites an existing file without `--force`, so it is safe to run in a populated
directory.

```bash
cd ~/code/my-api
harness init . --provider ollama --model ollama/qwen3-coder:30b
harness sync
```

Then make it yours:

1. **`docs/conventions.md`** — stack, test command, build command, layout. It is handed to
   every role on every call, so keep it short and true.
2. **`evals/*.yaml`** — replace `bun test` with your real test command, and rewrite the
   scenario as a feature you actually want to be able to ship.
3. **`roles/*.yaml`** — adjust permissions to your comfort. `bash: allow` on the developer
   is required for headless runs; if that makes you uneasy, work inside the dev container.

Commit the generated `opencode.json` and `.opencode/prompt/`: your teammates then get the
same agents in their opencode, with or without the harness.

> One gotcha: `init` skips files that already exist, **including `.gitignore`** — so the
> harness rules are not added to yours. Append them by hand:
>
> ```bash
> printf '\n# harness\n.harness/runs/\n.harness/evals/\n.harness/improve/\n' >> .gitignore
> ```

[example-project.md](example-project.md) walks through this on a real codebase — skeleton,
conventions, a project-specific eval, then the improve loop.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `agent "x" is a subagent, not a primary agent. Falling back to default agent` | a pipeline step uses a `mode: subagent` role | set `mode: all`; `harness validate` now rejects this |
| `local: declared but not served: <model>` | the model was unloaded, or the id changed | `harness doctor` lists what is served; update `models:` |
| `UnknownError` from opencode | wrong model id, or no credentials for that provider | `opencode models`, then `opencode auth login` |
| A step hangs or is denied | `permission: ask` in a headless run | use `allow` or `deny` |
| `opencode.json is stale` | roles changed since the last sync | `harness sync` |
| `<file> was hand-edited and no longer matches its role` | you edited a generated file | edit the YAML instead, or `harness sync --force` |
| `Cannot find module 'zod'` | dependencies not installed | `bun install` |
| `harness eval` refuses to start | not a git repository | `git init`, or `--in-place` and accept the risk |
| Editor errors like `Property mode is not allowed` | an unrelated YAML schema matched the file | `harness sync` regenerates `.harness/schema/`; the `$schema` modeline overrides the guess |
| `Template not found at …/template` | running the compiled binary | scaffold from a repo checkout |
