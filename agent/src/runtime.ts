import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { AgentRuntime } from "./agent.ts";
import type { AgentConfig } from "./config.ts";
import { PaperlessClient } from "./paperless.ts";

const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1";

/** Connects the agent to OpenRouter through Pi, routed to zero-data-retention endpoints only. */
export type RuntimeOverrides = { modelId?: string; reasoning?: ThinkingLevel; providers?: string[] };

export function createRuntime(config: AgentConfig, overrides: RuntimeOverrides = {}): AgentRuntime {
  const apiKey = process.env[config.model.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`${config.model.apiKeyEnv} is not set`);
  const modelId = overrides.modelId ?? config.model.id;
  const models = createModels();
  models.setProvider(openrouterProvider());
  const catalogModel = models.getModel("openrouter", modelId);
  if (!catalogModel) throw new Error(`OpenRouter model ${modelId} is not in Pi's model catalog`);
  // The configured providers belong to the configured model; another model may use any ZDR endpoint.
  const providers = overrides.providers ?? (modelId === config.model.id ? config.model.providers : []);
  const chatModel = viaChatCompletions(catalogModel);
  const model: Model<"openai-completions"> = {
    ...chatModel,
    compat: {
      ...chatModel.compat,
      openRouterRouting: {
        ...(providers.length > 0 ? { only: providers } : {}),
        zdr: true,
        data_collection: "deny" as const,
      },
    },
  };
  return {
    paperless: new PaperlessClient(config.paperlessUrl),
    model,
    streamFn: models.streamSimple.bind(models),
    getApiKey: () => apiKey,
    reasoning: overrides.reasoning ?? config.model.reasoning,
    maxTurns: config.maxTurns,
    timeoutMs: config.timeoutSeconds * 1000,
    maxResults: config.maxResults,
  };
}

/**
 * Pi reaches some OpenRouter models, such as Claude, through OpenRouter's Anthropic-style
 * messages endpoint, which does not take provider preferences. Without them the
 * zero-data-retention restriction would be lost, so every model goes through chat completions.
 */
function viaChatCompletions(model: Model<any>): Model<"openai-completions"> {
  if (model.api === "openai-completions") return model as Model<"openai-completions">;
  return {
    ...model,
    api: "openai-completions",
    baseUrl: CHAT_COMPLETIONS_URL,
    compat: {
      thinkingFormat: "openrouter",
      supportsStrictMode: true,
      sendSessionAffinityHeaders: true,
      ...(model.id.startsWith("anthropic/") ? { cacheControlFormat: "anthropic" as const } : {}),
    },
  };
}
