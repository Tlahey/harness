# Concepts

- [Roles](#roles)
- [Models and providers](#models-and-providers)
- [Pipelines](#pipelines)
- [Loops](#loops)
- [Placeholders](#placeholders)
- [Memory](#memory)
- [State](#state)
- [Teams](#teams)
- [What sync generates](#what-sync-generates)

## Roles

One role is one agent: a system prompt, a model, a set of tools, a set of permissions. The
file name is the role name.

```yaml
# yaml-language-server: $schema=../.harness/schema/role.json
description: Reviews the working-tree changes for correctness and fit. Reports; does not fix.

model: default # alias from models:, or a raw provider/model id
mode: all # primary | subagent | all
temperature: 0
team: [tester] # subagents this role may delegate to
memory: read # none | read | write

tools:
  edit: false # the reviewer cannot modify an existing file
  patch: false
  write: true # but it can create its report

permission:
  edit: allow
  bash: allow

outputs:
  - docs/design/latest.md # contract: injected into the prompt, checked after the run

prompt: |
  You are the Reviewer…
```

### `mode` decides more than you would think

`opencode run --agent <name>` **refuses a role whose mode is `subagent`** and falls back to
the default agent — the step would run with a completely different prompt, and only a
warning in the output would tell you. Any role used as a pipeline step, as an eval judge,
or as the improver must be `all` or `primary`. `harness validate` rejects the rest.

Use `all` unless you have a reason: it is both directly runnable and delegable.

### `tools` and `permission` are different levers

- `tools:` decides whether the tool **exists** for this role. `edit: false` means the model
  cannot call `edit` at all.
- `permission:` decides whether using it is **allowed**, denied, or subject to
  confirmation.

The shipped `reviewer` uses both: `write: true` so it can produce its report, `edit` and
`patch` off so it cannot "fix" the code it is reviewing. That separation is what keeps a
reviewer honest.

> `permission: ask` cannot work in a headless pipeline run — nobody is there to answer.
> `harness validate` warns about it.

### `outputs` is a contract

Files listed in `outputs:` are appended to the role's prompt as deliverables, and checked
on disk after the step. A missing deliverable does not fail the run, but it is recorded in
the manifest and surfaced by `harness report --all` — it is one of the strongest signals
that a prompt needs work.

## Models and providers

Models are declared once as aliases, so swapping one is a one-line change:

```yaml
defaults:
  model: default
models:
  default: ollama/qwen3-coder:30b
  deep: ollama/deepseek-r1:32b
```

A role points at an alias (`model: deep`) or at a raw id. A pipeline step can override its
role's model for that step only.

opencode knows hosted providers natively but **not** local servers: those need a `provider`
block declaring the base URL and every model used.

```yaml
provider:
  local:
    npm: "@ai-sdk/openai-compatible"
    name: Local server
    options:
      baseURL: http://127.0.0.1:8000/v1
      apiKey: admin
    models:
      Qwen3-Coder-Next-MLX-8bit:
        name: Qwen3-Coder-Next-MLX-8bit
```

`harness init` writes this for you after asking the endpoint what it serves.
`harness doctor` re-checks it later: server reachable, and every declared model actually
served.

## Pipelines

A pipeline is a DAG of steps. Steps whose dependencies are satisfied run concurrently, up
to `concurrency`.

```yaml
# yaml-language-server: $schema=../.harness/schema/pipeline.json
description: From a feature request to reviewed, tested code.

inputs:
  - name: task
    required: true

concurrency: 2

steps:
  - id: design
    role: architect
    outputs: [docs/design/latest.md]
    prompt: "{{ input.task }}"

  - id: implement
    role: developer
    needs: [design]
    model: deep # overrides the role's model, for this step only
    retry: 1 # re-run the step on a non-zero exit
    prompt: |
      Implement docs/design/latest.md.
      The architect said: {{ steps.design.output }}
```

Useful step options: `needs`, `model`, `retry`, `timeoutMs`, `outputs`,
`continueSession` (reuse the role's previous opencode session instead of a fresh one).

Partial replays:

```bash
harness pipeline run feature --from implement    # this step and everything downstream
harness pipeline run feature --only review
harness pipeline run feature --resume feature-2026-08-09T21-01-59 --from implement
```

`--resume` reuses a previous run's directory and rehydrates the transcripts of successful
steps, so `{{ steps.x.output }}` still resolves for the steps you are not re-running.

## Loops

A loop repeats its body until a regex matches the output of one of its steps.

```yaml
- id: verify
  needs: [implement]
  loop:
    until: "VERDICT:\\s*approved"
    check: review # which body step to test; defaults to the first
    max: 3
    onExhausted: fail # or continue
    body:
      - id: review
        role: reviewer
        prompt: "Iteration {{ loop.iteration }} of {{ loop.max }}…"
      - id: test
        role: tester
      - id: fix
        role: developer
```

Semantics worth knowing:

- The body runs **in order**; `needs` is not allowed inside a loop.
- The condition is tested **right after the checked step**, so a satisfied condition skips
  the rest of the body instead of running `fix` for nothing.
- `{{ steps.review.output }}` refers to the **current** iteration.
- Exhausting `max` without matching marks the loop failed (`onExhausted: fail`), which
  stops the pipeline. `continue` lets the run carry on and records the fact.

## Placeholders

| Placeholder | Contents |
|---|---|
| `{{ input.<name> }}` | a pipeline input |
| `{{ steps.<id>.output }}` | full text output of a step you depend on |
| `{{ steps.<id>.file }}` | path to that step's transcript |
| `{{ steps.<id>.status }}` | `success` / `failed` |
| `{{ loop.iteration }}`, `{{ loop.max }}`, `{{ loop.id }}` | inside a loop body |
| `{{ state.<key> }}` | shared state |
| `{{ run.id }}`, `{{ run.dir }}` | run identifier and artefact directory |
| `{{ project.name }}`, `{{ workspace }}` | project name and root |

`harness validate` checks these **before** anything runs: `{{ steps.x.output }}` without
`needs: [x]` is an error, not a silently empty prompt.

Prefer `{{ steps.x.file }}` when the output is long: it costs a path instead of copying a
whole transcript into the next prompt.

## Memory

Memory is markdown files, not a tool call. Agents read and write it with their normal file
tools, it diffs in review, and it survives a change of provider.

```
memory/
  MEMORY.md          index, regenerated — never edited by hand
  stack-bun.md       one fact per file
```

```markdown
---
name: stack-bun
description: "Runtime is Bun, not Node"
type: convention
---

The project targets Bun; Node-only APIs are not available.
```

Only the **index** goes into prompts; entries are read on demand, so memory can grow
without inflating every call. `memory: read` injects the index, `memory: write` also adds
the instruction to record what the role learns.

```bash
echo "The project targets Bun." | harness memory add stack-bun -d "Runtime is Bun" --type convention
harness memory          # list
harness memory sync     # rebuild the index
```

## State

A flat JSON key/value store shared across runs.

```bash
harness state set sprint 12
harness state set release_branch release/1.4
```

Then `{{ state.sprint }}` in any prompt. Values that look like numbers or booleans are
stored as such. State is for facts that outlive a run; anything run-scoped belongs in the
pipeline inputs.

## Teams

A role can declare the subagents it may delegate to:

```yaml
team: [architect, developer, reviewer, tester]
```

The generated prompt lists each teammate with its description, plus the rules of
delegation — a subagent cannot see the caller's conversation, so the brief has to stand
alone. Delegation itself is opencode's `task` tool; `harness validate` errors if you
declare a team while disabling `task`.

Teams matter for the interactive entry point (`opencode --agent lead`), where one agent
fans work out. Pipelines do their fan-out in the DAG instead.

## What sync generates

```
opencode.json          model, permission, provider, mcp, instructions, agent{…}
.opencode/prompt/*.md  one assembled system prompt per role
.harness/schema/*.json JSON Schemas for the YAML files
.harness/sync.json     fingerprints of everything above
```

Each agent entry points at its prompt with `{file:./.opencode/prompt/<role>.md}`, which is
opencode's own indirection — the JSON stays readable and the prompts stay diffable.

These files are meant to be committed: once generated, opencode works without the harness.

`sync` records a fingerprint of what it wrote. A generated file edited by hand is reported
as **drift** and never overwritten without `--force`. `harness sync --check` exits 1 when
the configuration is stale, which makes it a useful CI step.
