# Configuration

`harness.config.yaml` sits at the project root and defines everything the roles share. The
file carries a `$schema` modeline, so an editor with the YAML extension validates it and
autocompletes it against [`.harness/schema/config.json`](#editor-validation).

## Full reference

### `project`

```yaml
project:
  name: my-app # required; shown in prompts and reports
  description: Application developed by the agent harness.
```

### `defaults`

Inherited by every role that does not override the key. `model` is required — it is the
one setting a project cannot do without.

```yaml
defaults:
  model: default # alias or provider/model
  temperature: 0.2
  tools: { } # applied to every role, merged with the role's own
  permission:
    edit: allow
    bash: ask
    webfetch: allow
```

`permission.bash` also accepts a map of command globs:

```yaml
permission:
  bash:
    "git push": deny
    "*": allow
```

### `models`

Aliases. A role referencing an unknown alias fails validation, not the run.

```yaml
models:
  default: ollama/qwen3-coder:30b
  deep: ollama/deepseek-r1:32b
```

### `paths`

Every path is relative to the config file. Defaults shown.

```yaml
paths:
  roles: ./roles
  pipelines: ./pipelines
  evals: ./evals
  memory: ./memory
  artifacts: ./.harness/runs
  state: ./.harness/state.json
  prompts: ./.opencode/prompt
  opencodeConfig: ./opencode.json
```

### `opencode`

```yaml
opencode:
  binary: opencode # or an absolute path
  args: [] # appended to every `opencode run`
  env: {} # extra environment for the child process
```

### `memory`

```yaml
memory:
  enabled: true # false removes the memory section from every prompt
  index: MEMORY.md
  maxEntries: 50 # past this, `harness memory` asks you to merge entries
```

### `improve`

```yaml
improve:
  role: improver
  scope: # the only paths the improver may rewrite
    - roles/
    - memory/
  requireBaseline: true # refuse to improve without an eval baseline
```

Setting `requireBaseline: false` means accepting prompt changes you cannot evaluate. It is
supported, and it is a real decision — see [evaluation.md](evaluation.md).

### `provider`

Passed through verbatim to `opencode.json`. Required for anything opencode does not know
natively: Ollama, LM Studio, oMLX, vLLM, LiteLLM, any OpenAI-compatible gateway.

```yaml
provider:
  local:
    npm: "@ai-sdk/openai-compatible"
    name: Local server
    options:
      baseURL: http://127.0.0.1:8000/v1
      apiKey: admin # use {env:MY_KEY} to keep it out of the repo
    models:
      Qwen3-Coder-Next-MLX-8bit:
        name: Qwen3-Coder-Next-MLX-8bit
```

Every model used **must** appear under `models:` or opencode will not resolve it.
`harness init` builds this block from the models you pick; `harness doctor` verifies it
against what the server actually serves.

### `mcp`

Passed through verbatim to `opencode.json`. MCP servers are configured the opencode way;
the harness does not wrap them.

```yaml
mcp:
  playwright:
    type: local
    command: ["npx", "-y", "@playwright/mcp@latest"]
```

### `instructions`

Files handed to every opencode session, on top of each role's own prompt.

```yaml
instructions:
  - docs/conventions.md
  - memory/MEMORY.md
```

Keep them short: this is paid for on every single call. `harness validate` errors if a
listed file does not exist.

### `run`

```yaml
run:
  concurrency: 2 # steps in flight at once, unless a pipeline overrides it
  timeoutMs: 1800000 # per step; a step can override it
```

## Editor validation

The YAML files carry a modeline pointing at a generated schema:

```yaml
# yaml-language-server: $schema=../.harness/schema/role.json
```

Those schemas are produced from the same zod definitions the CLI validates against, so
editor hints and `harness validate` cannot disagree. They are written by `harness init` and
refreshed by `harness sync`, and they should be committed.

The modeline also **overrides** whatever schema your editor would otherwise associate by
file name — which is what removes spurious errors like `Property mode is not allowed`
coming from an unrelated schema that happened to match `roles/*.yaml`.

If your editor still ignores it, check that the [YAML
extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) is
installed (the dev container installs it) and that `.harness/schema/` exists — run
`harness sync`.

## Precedence

For a given step, the model is resolved in this order:

1. the step's `model:`
2. the role's `model:`
3. `defaults.model`

then run through `models:` aliases. `tools` and `permission` merge in the same direction:
`defaults` first, role second, and the role wins on conflict.
