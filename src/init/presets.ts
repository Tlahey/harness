import type { Choice } from "../util/prompt.ts";

export interface LocalEndpoint {
  /** Provider key in opencode.json, and prefix of every model id: `ollama/qwen3…`. */
  key: string;
  name: string;
  defaultBaseURL: string;
  /** Some local servers want a token even when they ignore its value. */
  askApiKey?: boolean;
}

export interface Preset {
  id: string;
  label: string;
  hint: string;
  /** Set for OpenAI-compatible servers: harness asks for the URL and lists what it serves. */
  endpoint?: LocalEndpoint;
  /** Fallback suggestions when the endpoint cannot be queried. */
  models: Choice[];
  setup: string[];
}

/** `ollama/qwen3-coder:30b` -> `qwen3-coder:30b` */
export function stripPrefix(modelId: string): string {
  const index = modelId.indexOf("/");
  return index < 0 ? modelId : modelId.slice(index + 1);
}

/**
 * opencode does not know local servers natively: every model used has to be declared here,
 * or it will not resolve.
 */
export function buildProviderBlock(
  endpoint: LocalEndpoint,
  baseURL: string,
  apiKey: string | undefined,
  modelIds: string[],
): Record<string, unknown> {
  const options: Record<string, unknown> = { baseURL };
  if (apiKey) options.apiKey = apiKey;

  return {
    [endpoint.key]: {
      npm: "@ai-sdk/openai-compatible",
      name: endpoint.name,
      options,
      models: Object.fromEntries([...new Set(modelIds.map(stripPrefix))].map((id) => [id, { name: id }])),
    },
  };
}

/** Asks the server what it actually serves. Local model lists change every time you load one. */
export async function discoverModels(baseURL: string, apiKey?: string): Promise<string[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id));
}

export const PRESETS: Preset[] = [
  {
    id: "ollama",
    label: "Ollama (local, open source)",
    hint: "local models, nothing leaves the machine",
    endpoint: { key: "ollama", name: "Ollama (local)", defaultBaseURL: "http://localhost:11434/v1" },
    models: [
      { value: "ollama/qwen3-coder:30b", label: "qwen3-coder:30b" },
      { value: "ollama/qwen2.5-coder:32b", label: "qwen2.5-coder:32b" },
      { value: "ollama/devstral:24b", label: "devstral:24b" },
      { value: "ollama/gpt-oss:20b", label: "gpt-oss:20b" },
    ],
    setup: ["`ollama serve` must be running", "`ollama pull <model>` for every model you use"],
  },
  {
    id: "lmstudio",
    label: "LM Studio (local, open source)",
    hint: "local OpenAI-compatible server",
    endpoint: { key: "lmstudio", name: "LM Studio (local)", defaultBaseURL: "http://localhost:1234/v1" },
    models: [
      { value: "lmstudio/qwen/qwen3-coder-30b", label: "qwen/qwen3-coder-30b" },
      { value: "lmstudio/openai/gpt-oss-20b", label: "openai/gpt-oss-20b" },
    ],
    setup: ["load the model in LM Studio and start its local server"],
  },
  {
    id: "openai-compatible",
    label: "Other local OpenAI-compatible server (oMLX, vLLM, LiteLLM…)",
    hint: "you give the URL, harness lists what it serves",
    endpoint: {
      key: "local",
      name: "Local server",
      defaultBaseURL: "http://127.0.0.1:8000/v1",
      askApiKey: true,
    },
    models: [],
    setup: ["the server must be running before every run", "`harness doctor` checks the endpoint and the declared models"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (hosted open-weight models)",
    hint: "open weights without a local GPU",
    models: [
      { value: "openrouter/qwen/qwen3-coder", label: "qwen/qwen3-coder" },
      { value: "openrouter/deepseek/deepseek-chat-v3.1", label: "deepseek/deepseek-chat-v3.1" },
      { value: "openrouter/moonshotai/kimi-k2", label: "moonshotai/kimi-k2" },
      { value: "openrouter/z-ai/glm-4.6", label: "z-ai/glm-4.6" },
    ],
    setup: ["`opencode auth login` (OpenRouter)"],
  },
  {
    id: "anthropic",
    label: "Anthropic (proprietary)",
    hint: "Claude models",
    models: [
      { value: "anthropic/claude-sonnet-4-5", label: "claude-sonnet-4-5" },
      { value: "anthropic/claude-opus-4-5", label: "claude-opus-4-5" },
      { value: "anthropic/claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
    setup: ["`opencode auth login` (Anthropic)"],
  },
  {
    id: "custom",
    label: "Already configured in opencode",
    hint: "you type the provider/model ids yourself",
    models: [],
    setup: ["the provider must already exist in your global opencode config"],
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
