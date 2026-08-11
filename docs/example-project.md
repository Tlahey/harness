# Example: setting up harness on a real project

A complete walkthrough on a small but real codebase — a URL shortener API — from empty
directory to a measured self-improvement loop.

Every command below was run for real. Where an agent's output would appear, it is marked
*illustrative*: the shape is right, the wording depends on your model.

- [The project](#the-project)
- [Step 1 — establish the shape](#step-1--establish-the-shape)
- [Step 2 — install harness into it](#step-2--install-harness-into-it)
- [Step 3 — tell the agents about the project](#step-3--tell-the-agents-about-the-project)
- [Step 4 — write an eval that means something](#step-4--write-an-eval-that-means-something)
- [Step 5 — check before spending](#step-5--check-before-spending)
- [Step 6 — run the pipeline](#step-6--run-the-pipeline)
- [Step 7 — read the traces](#step-7--read-the-traces)
- [Step 8 — record what was learned](#step-8--record-what-was-learned)
- [Step 9 — measure, then improve](#step-9--measure-then-improve)
- [The result](#the-result)
- [Adapting to another stack](#adapting-to-another-stack)

## The project

`linkshort`: an HTTP API that shortens URLs. Chosen because it is small enough to read in
one sitting and real enough to have behaviour worth testing — persistence, redirects,
error cases.

```
POST /links     {"url": "..."}  ->  201 {"slug": "ab12cd", "url": "..."}
GET  /<slug>                    ->  302 to the stored url
GET  /health                    ->  200 {"status": "ok"}
```

Stack: TypeScript on Bun, `bun:sqlite`, `bun test`. No dependencies, so the eval's
`bun test` assertion works out of the box.

## Step 1 — establish the shape

Agents do not need you to write code. They need to know **what shape you want** — and that
knowledge comes from one of two places: existing code, or a written spec. If neither
exists, the first run invents a structure and every later run inherits it.

So there are two ways in, and both are legitimate:

| | Greenfield | Existing project |
|---|---|---|
| Where the shape comes from | `AGENTS.md`, written from your brief | the code that is already there |
| First command | `harness pipeline run bootstrap` | `harness init .` |
| You write | a few sentences | nothing |

### Greenfield: the harness builds the base

You do not write the skeleton. The `bootstrap` pipeline plans it, scaffolds it and checks
it actually runs:

```bash
mkdir linkshort && cd linkshort && git init -b main
harness init . --provider ollama --model ollama/qwen3-coder:30b --yes
harness sync

harness pipeline run bootstrap --input brief="\
A URL shortener API. POST /links takes a url and returns a slug; GET /<slug> redirects.
TypeScript on Bun, bun:sqlite for storage, bun test. No web framework."
```

| Step | Role | Produces |
|---|---|---|
| plan | architect | `AGENTS.md` — stack, commands, layout, rules — and `docs/design/latest.md` |
| scaffold | developer | the project: it installs, it builds, one real test passes |
| verify | tester | runs the commands `AGENTS.md` claims exist, and reports the truth |

That last step is the one that earns its keep. It catches the classic failure where the
conventions file documents `npm test` and the project only answers to `bun test` — left
alone, every later run inherits the contradiction.

Here is what the `plan` step really wrote from the brief above, on a local 8-bit
Qwen3-Coder. `AGENTS.md`:

```markdown
## Stack
- Language: TypeScript (ESM, no JSX)
- Package manager: Bun (bun:sqlite, bun:test built-in, no npm/yarn)
- Test command: `bun test`
- Build command: none (Bun runs TypeScript directly)

## What good looks like
- Routing lives in a single `handle()` function in `src/server.ts`. Add branches there;
  do not add a router library.
- Tests call handlers directly without starting a server.
- Database connection is a singleton in `src/db.ts`. Tests use an in-memory database.
- Slugs are 6-character URL-safe base62 strings. Do not use UUIDs or 雪花 IDs.
```

and `docs/design/latest.md` opened with its assumptions, closed rather than asked:

```markdown
## Assumptions
1. No framework routing — manual routing in a single `handle()` function
2. Slugs are 6-character base62 — generated from crypto random bytes
3. 301 redirects — permanent redirects for SEO friendliness
4. In-memory SQLite for tests — faster, isolated between runs
```

**Read it, then fix it.** That is the one manual step worth your time: `AGENTS.md` is read
on every call by every role, so a wrong line is paid for hundreds of times. In the run
above there are two things to correct — a stray `雪花` from an 8-bit model, and a 301 that
should probably be a 302 for a shortener you may want to re-point later. Neither is
catastrophic; both would have propagated silently.

> **On a small local model, budget time.** In that run the `plan` step ran past the
> 30-minute default and was killed mid-write, leaving the design in place but the pipeline
> failed. The shipped `bootstrap` now sets `timeoutMs: 3600000` on that step and tells the
> architect to write the two files and stop. If you see `plan timed out`, raise it further
> or use a faster model for that step: `--input` is not the only knob, `model:` on the step
> works too.

### The skeleton this page refers to

Whether `bootstrap` wrote it or you did, the rest of this walkthrough talks about the code
below. It is here so you can read it, not so you type it.

`package.json`:

```json
{
  "name": "linkshort",
  "type": "module",
  "scripts": {
    "dev": "bun run src/server.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "@types/bun": "^1.1.14", "typescript": "^5.7.2" }
}
```

`src/db.ts`:

```ts
import { Database } from "bun:sqlite";

export const db = new Database(process.env.LINKSHORT_DB ?? ":memory:");

db.run(`
  CREATE TABLE IF NOT EXISTS links (
    slug TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
```

`src/server.ts` — one `handle()` function, because a single obvious extension point is
easier for an agent to extend correctly than a router it has to discover:

```ts
import { db } from "./db.ts";

export function handle(request: Request): Response {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  const slug = url.pathname.slice(1);
  if (request.method === "GET" && slug) {
    const row = db.query("SELECT url FROM links WHERE slug = ?").get(slug) as { url: string } | null;
    if (row) return Response.redirect(row.url, 302);
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Bun.serve({ port: 3000, fetch: handle });
}
```

`src/server.test.ts` — this is the file the tester role will imitate, so make it the style
you want:

```ts
import { expect, test } from "bun:test";
import { handle } from "./server.ts";

test("GET /health returns ok", async () => {
  const response = handle(new Request("http://localhost/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("unknown slug is a 404", () => {
  expect(handle(new Request("http://localhost/nope")).status).toBe(404);
});
```

Whatever produced it, commit before going further:

```bash
bun test          # 2 pass, 0 fail
git add -A && git commit -m "linkshort: health, slug redirect, tests"
```

The commit matters: evals run from HEAD, and `improve` rolls back with git.

## Step 2 — install harness into it

```bash
harness init . --provider openai-compatible --base-url http://127.0.0.1:8000/v1
```

Or with a hosted provider:

```bash
harness init . --provider anthropic --model anthropic/claude-sonnet-4-5 --yes
```

`init` never overwrites an existing file without `--force`, so it is safe in a populated
directory. **That includes your `.gitignore`** — the template's version is skipped, so the
harness rules are not added. Append them yourself:

```bash
cat >> .gitignore <<'EOF'

# harness
.harness/runs/
.harness/evals/
.harness/improve/
EOF
```

Everything else under `.harness/` — `schema/`, `sync.json`, later `baseline.json` — is
meant to be committed.

Then set the project identity in `harness.config.yaml`, which still says `my-app`:

```yaml
project:
  name: linkshort
  description: URL shortener API on Bun and SQLite.
```

## Step 3 — tell the agents about the project

`AGENTS.md` is read by **every role on every call**. opencode loads it from the project
root by itself, so it also applies when you use opencode without the harness — and to any
other tool that follows the AGENTS.md convention.

It is the highest-leverage file in the whole setup, and the one most people leave as the
placeholder. If you ran `bootstrap`, the architect already wrote it; edit it. Otherwise:

````markdown
# AGENTS.md

## Stack

- Language: TypeScript on Bun (no Node-only APIs)
- Package manager: bun
- Test command: `bun test`
- Typecheck command: `bun run typecheck`
- Storage: `bun:sqlite`, one `Database` exported from `src/db.ts`

## Rules

- Routing lives in `handle()` in `src/server.ts`. Add a branch there; do not add a router.
- Every endpoint returns JSON via `Response.json`, except redirects.
- A test file sits next to the file it tests: `src/x.ts` -> `src/x.test.ts`.
- Tests call `handle()` directly with a `Request`. Do not start a server in tests.
- No new dependency unless the design document names it.

## Layout

```
src/db.ts          sqlite connection and schema
src/server.ts      handle(request) -> Response, and the Bun.serve entrypoint
src/*.test.ts      bun:test, colocated
```
````

Notice what these rules do: each one closes off a plausible-but-unwanted decision. "Do not
add a router" and "do not start a server in tests" exist because a capable model will
otherwise do both, reasonably, and leave you with a codebase you did not choose.

The shipped roles need no change for this project — `bun test` is discovered from
`AGENTS.md`, and the reviewer already reads `git diff`. Adjust `roles/*.yaml` only when a
role misbehaves, and prefer doing it with a trace in hand (see [evaluation.md](evaluation.md)).

## Step 4 — write an eval that means something

Delete the shipped example and write one for a feature you actually want to be able to
ship:

```bash
rm evals/health-endpoint.yaml
```

`evals/create-link.yaml`:

```yaml
# yaml-language-server: $schema=../.harness/schema/eval.json
description: Can the pipeline add a POST endpoint that persists a link and redirects to it?

pipeline: feature

inputs:
  task: >-
    Add POST /links accepting {"url": "..."} and returning 201 with {"slug": "...", "url": "..."}.
    The slug must be persisted so that GET /<slug> redirects to the stored url.

assert:
  - type: file_exists
    path: docs/design/latest.md
    description: the design was written

  - type: step_output
    step: review
    pattern: "VERDICT:\\s*approved"
    description: the review ends on an approval

  - type: command
    run: bun test
    expectExit: 0
    description: the whole suite passes
    weight: 2

  - type: command
    run: bun run typecheck
    expectExit: 0
    description: no type errors

  - type: judge
    role: judge
    weight: 2
    prompt: |
      Verify that POST /links really exists in src/server.ts, that it stores the slug and
      url in the links table, and that GET /<slug> redirects to the stored url.

      Read the code and run `bun test`. Do not trust any agent report.
      Answer with your verdict format.
```

The mix is deliberate. The cheap assertions (file, command, regex) are objective but only
see artefacts — a run can produce a design, pass the existing tests, and still not have
built the feature. The judge is the one that opens `src/server.ts` and checks the redirect
actually reads from the table. Weighting it 2 says so.

## Step 5 — check before spending

```bash
harness sync
harness validate
harness doctor
```

Real output on this project:

```
✓ opencode 1.17.15
✓ local reachable (15 model(s) served)
  outside the container: agents write straight to your machine
✓ 7 role(s), 1 pipeline(s), 1 eval(s) valid
✓ opencode.json is up to date
```

Then dry-run, which resolves every placeholder and prints the exact commands without
spending a token:

```bash
harness pipeline run feature --input task='Add POST /links accepting {"url":"..."}' --dry-run
```

```
› design (architect · local/Qwen3-Coder-Next-MLX-8bit)
  opencode run --agent architect --model local/Qwen3-Coder-Next-MLX-8bit 'Feature request:
Add POST /links accepting {"url":"..."}

Produce the technical design and write it to docs/design/latest.md.'
› implement (developer · local/Qwen3-Coder-Next-MLX-8bit)
  ...
↻ verify — until /VERDICT:\s*approved/ (max 3)
```

## Step 6 — run the pipeline

```bash
git status --short          # start clean: the reviewer reads the diff
harness pipeline run feature \
  --input task='Add POST /links accepting {"url": "..."} returning 201 with the slug, persisted so GET /<slug> redirects' \
  --verbose
```

What each stage is constrained to do:

| Step | Role | Can it edit code? | Ends with |
|---|---|---|---|
| design | architect | no (`bash: deny`, no `patch`) | `docs/design/latest.md` |
| implement | developer | yes | changed files, build and tests run |
| review | reviewer | no (`edit`/`patch` off) | `VERDICT: approved` or `changes-requested` |
| test | tester | yes | `TESTS: pass` or `fail (n failing)` |
| fix | developer | yes | fixes, or a reasoned disagreement |

The `verify` loop stops as soon as the review approves — when it does, `test` and `fix` do
not run that iteration.

*Illustrative* summary:

```
› design (architect · …)          ✓ design in 41s
› implement (developer · …)       ✓ implement in 2m18s
↻ verify — until /VERDICT:\s*approved/ (max 3)
› [1/3] review (reviewer · …)     ✓ review in 55s
› [1/3] test (tester · …)         ✓ test in 1m12s
› [1/3] fix (developer · …)       ✓ fix in 48s
› [2/3] review (reviewer · …)     ✓ review in 39s
✓ verify: condition met on iteration 2
```

Now do the thing the harness cannot do for you: read the diff.

```bash
git diff
cat docs/design/latest.md
bun test
```

## Step 7 — read the traces

```bash
harness report            # timeline of that run
harness report --all      # per-role failures, retries, forgotten deliverables
```

`report --all` is what tells you where to spend effort. A tester that never forgets a
deliverable and a reviewer that always needs two iterations are two very different
problems: the second one usually means the reviewer's bar and the developer's brief
disagree.

## Step 8 — record what was learned

When a run surfaces something durable, put it in memory so the next run starts with it:

```bash
echo "Redirects use Response.redirect(url, 302); tests assert status and Location, and never follow." \
  | harness memory add redirect-testing -d "How redirects are tested here" --type convention
```

Only the index enters prompts, so memory can grow without inflating every call. The
`architect` and `lead` roles ship with `memory: write`, meaning they are also told to
record what they learn on their own.

## Step 9 — measure, then improve

```bash
git add -A && git commit -m "feat: POST /links"    # evals run from HEAD
harness eval --save-baseline
```

The eval replays the whole scenario in a detached git worktree — your working tree is not
touched — and scores it:

*Illustrative:*

```
▶ eval create-link — pipeline feature
create-link 71% — 3/5 assertions
  ✓ the design was written 1843 characters
  ✓ the review ends on an approval pattern found
  ✗ the whole suite passes code 1 — 1 fail
  ✓ no type errors code 0
  ✗ judged by judge VERDICT: fail
```

A first score below 100% is the normal case, and it is the point: you now have a number to
move. Then, and only then:

```bash
harness improve                 # proposal only, changes nothing
harness improve --apply --eval  # applies, re-evaluates, rolls back on regression
```

The improver gets a briefing built from your runs and this eval, and may only edit
`roles/` and `memory/`. If the score drops, its changes are reverted. The guardrails are
detailed in [evaluation.md](evaluation.md).

## The result

```
linkshort/
├── src/                      your code — the only thing that ships
│   ├── db.ts
│   ├── server.ts
│   └── server.test.ts
├── AGENTS.md                 read by every role, every call — and by bare opencode
├── docs/design/latest.md     written by the architect each run
├── roles/*.yaml              7 roles: lead, architect, developer, reviewer,
│                             tester, judge, improver
├── pipelines/
│   ├── bootstrap.yaml        greenfield: plan → scaffold → verify
│   └── feature.yaml          design → implement → (review ∥ test → fix)*
├── evals/create-link.yaml    the scenario you are scored on
├── memory/                   what the project has learned
├── opencode.json             generated — commit it
├── .opencode/prompt/*.md     generated system prompts — commit them
├── .harness/
│   ├── schema/*.json         editor validation — commit
│   ├── sync.json             drift fingerprints — commit
│   ├── baseline.json         reference scores — commit
│   └── runs/                 transcripts, manifests, events — ignored
└── .devcontainer/            sandbox for agents with bash: allow
```

The generated `opencode.json` is plain opencode configuration: a teammate who clones this
repo gets the same seven agents in their own opencode, harness or not.

## Adapting to another stack

The only project-specific parts are `AGENTS.md` and the `command` assertions in your evals.
Everything else is stack-agnostic.

| Stack | AGENTS.md test command | eval assertion |
|---|---|---|
| Bun | `bun test` | `run: bun test` |
| Node + pnpm | `pnpm test` | `run: pnpm test` |
| Python + uv | `uv run pytest` | `run: uv run pytest` |
| Go | `go test ./...` | `run: go test ./...` |
| Rust | `cargo test` | `run: cargo test` |

Two adjustments worth making early on a larger codebase:

- **Point the architect at the right subtree.** Name the directories that matter in the
  `Layout` section of `AGENTS.md`, or the design step will explore for minutes before
  writing anything.
- **Raise `run.timeoutMs`** if your build is slow. The default is 30 minutes per step;
  a step that dies mid-build leaves a half-applied change.
