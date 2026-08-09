# AGENTS.md

Instructions for every agent working in this repository. opencode loads this file
automatically, so it applies with or without the harness — and to any other tool that
follows the AGENTS.md convention.

It is read on **every call, by every role**. Keep it short and decisive: this is the most
expensive file in the project, and the most useful one.

## Stack

<!-- Replace once the project exists. `harness pipeline run bootstrap` fills this in. -->

- Language:
- Package manager:
- Test command:
- Build command:

## Rules

- Match the surrounding code. New patterns need a reason stated in the design.
- No new dependency unless the design document names it.
- Never commit or push unless the task explicitly asks for it.
- Secrets stay in `.env`; never hardcode credentials.

## Layout

<!-- Name the directories that matter, so agents stop guessing. -->

## What good looks like

<!--
State the decisions you do not want re-litigated on every run. The useful entries are the
ones that close off a plausible-but-unwanted choice, for example:

- Routing lives in `handle()` in `src/server.ts`. Add a branch there; do not add a router.
- Tests call the handler directly. Do not start a server in tests.
-->
