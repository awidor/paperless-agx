import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** A model Pi's catalog does not list yet, described the way Pi takes custom models. */
export type ModelDefinition = {
  name: string;
  images: boolean;
  /** USD per million tokens. */
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  contextWindow: number;
  maxTokens: number;
};

export type AgentConfig = {
  host: string;
  port: number;
  paperlessUrl: string;
  /** The one model behind every agent: indexing and search. */
  model: {
    id: string;
    reasoning: ThinkingLevel;
    apiKeyEnv: string;
    /** OpenRouter providers to route to. Every request also requires zero data retention. */
    providers: string[];
    definition: ModelDefinition | null;
  };
  search: {
    maxTurns: number;
    timeoutSeconds: number;
    maxResults: number;
  };
  indexing: {
    timeoutSeconds: number;
    pagesPerView: number;
  };
};

const REASONING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export async function loadConfig(path: string): Promise<AgentConfig> {
  const raw = Bun.TOML.parse(await Bun.file(path).text()) as Record<string, any>;
  const [host, port] = splitListen(text(raw.listen, "listen"));
  const model = raw.model ?? {};
  const limits = raw.limits ?? {};
  const indexing = raw.indexing ?? {};
  const reasoning = text(model.reasoning ?? "medium", "model.reasoning") as ThinkingLevel;
  if (!REASONING_LEVELS.includes(reasoning)) {
    throw new Error(`model.reasoning must be one of ${REASONING_LEVELS.join(", ")}`);
  }
  const providers = model.providers ?? [];
  if (!Array.isArray(providers) || providers.some((provider) => typeof provider !== "string" || !provider.trim())) {
    throw new Error("model.providers must be a list of OpenRouter provider names");
  }
  return {
    host,
    port,
    paperlessUrl: text(raw.paperless_url, "paperless_url").replace(/\/+$/, ""),
    model: {
      id: text(model.id, "model.id"),
      reasoning,
      apiKeyEnv: text(model.api_key_env ?? "OPENROUTER_API_KEY", "model.api_key_env"),
      providers,
      definition: model.definition ? definition(model.definition) : null,
    },
    search: {
      maxTurns: positive(limits.max_turns ?? 8, "limits.max_turns", 2),
      // Bun closes a connection after 255 seconds without data.
      timeoutSeconds: Math.min(positive(limits.timeout_seconds ?? 90, "limits.timeout_seconds", 1), 240),
      maxResults: positive(limits.max_results ?? 10, "limits.max_results", 1),
    },
    indexing: {
      // The stream sends a keep-alive, so indexing may run past Bun's idle limit.
      timeoutSeconds: positive(indexing.timeout_seconds ?? 900, "indexing.timeout_seconds", 1),
      pagesPerView: positive(indexing.pages_per_view ?? 4, "indexing.pages_per_view", 1),
    },
  };
}

function definition(raw: Record<string, any>): ModelDefinition {
  return {
    name: text(raw.name, "model.definition.name"),
    images: raw.images === true,
    inputCost: price(raw.input_cost, "model.definition.input_cost"),
    outputCost: price(raw.output_cost, "model.definition.output_cost"),
    cacheReadCost: price(raw.cache_read_cost ?? 0, "model.definition.cache_read_cost"),
    cacheWriteCost: price(raw.cache_write_cost ?? 0, "model.definition.cache_write_cost"),
    contextWindow: positive(raw.context_window, "model.definition.context_window", 1),
    maxTokens: positive(raw.max_tokens, "model.definition.max_tokens", 1),
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function price(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a price of at least 0`);
  }
  return value;
}

function positive(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${field} must be an integer of at least ${minimum}`);
  }
  return value;
}

function splitListen(listen: string): [string, number] {
  const separator = listen.lastIndexOf(":");
  const port = Number(listen.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port) || port <= 0) throw new Error("listen must look like 0.0.0.0:3100");
  return [listen.slice(0, separator), port];
}
