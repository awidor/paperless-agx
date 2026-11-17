import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentRuntime } from "./agent.ts";
import type { AgentConfig } from "./config.ts";
import { createOpenRouterModels, resolveModel } from "./model.ts";
import { PaperlessClient } from "./paperless.ts";

/** Overrides for trying other settings, as the benchmarks do. */
export type RuntimeOverrides = {
  modelId?: string;
  reasoning?: ThinkingLevel;
  providers?: string[];
  /** Search by meaning as well as by keywords. Default true. */
  semantic?: boolean;
  /** Search and show the documents' summaries. Default true. */
  summaries?: boolean;
};

/** Connects the agents to OpenRouter through Pi, routed to zero-data-retention endpoints only. */
export function createRuntime(config: AgentConfig, overrides: RuntimeOverrides = {}): AgentRuntime {
  const apiKey = process.env[config.model.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`${config.model.apiKeyEnv} is not set`);
  const modelId = overrides.modelId ?? config.model.id;
  const ownModel = modelId === config.model.id;
  // The configured providers and definition belong to the configured model; another model
  // must be in Pi's catalog and may use any zero-data-retention endpoint.
  const providers = overrides.providers ?? (ownModel ? config.model.providers : []);
  const models = createOpenRouterModels();
  return {
    paperless: new PaperlessClient(config.paperlessUrl),
    model: resolveModel(models, modelId, ownModel ? config.model.definition : null, providers),
    streamFn: models.streamSimple.bind(models),
    getApiKey: () => apiKey,
    reasoning: overrides.reasoning ?? config.model.reasoning,
    maxTurns: config.search.maxTurns,
    timeoutMs: config.search.timeoutSeconds * 1000,
    maxResults: config.search.maxResults,
    search: { semantic: overrides.semantic ?? true, summaries: overrides.summaries ?? true },
    indexing: {
      timeoutMs: config.indexing.timeoutSeconds * 1000,
      pagesPerView: config.indexing.pagesPerView,
    },
  };
}
