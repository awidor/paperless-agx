import { createModels, type Model } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelDefinition } from "./config.ts";

const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1";

/**
 * The OpenRouter model to run, routed to zero-data-retention endpoints only. A model Pi's
 * catalog does not list yet comes from its definition in the config, the way Pi takes custom
 * models; the definition can go once Pi's catalog has the model.
 */
export function resolveModel(
  models: ReturnType<typeof createModels>,
  id: string,
  definition: ModelDefinition | null,
  providers: string[],
): Model<"openai-completions"> {
  const catalogModel = models.getModel("openrouter", id);
  const base = catalogModel ? viaChatCompletions(catalogModel) : definition ? defined(id, definition) : null;
  if (!base) {
    throw new Error(`OpenRouter model ${id} is not in Pi's model catalog; describe it under [model.definition]`);
  }
  return {
    ...base,
    compat: {
      ...base.compat,
      openRouterRouting: {
        ...(providers.length > 0 ? { only: providers } : {}),
        zdr: true,
        data_collection: "deny" as const,
      },
    },
  };
}

export function createOpenRouterModels() {
  const models = createModels();
  models.setProvider(openrouterProvider());
  return models;
}

function defined(id: string, definition: ModelDefinition): Model<"openai-completions"> {
  return {
    type: "chat",
    id,
    name: definition.name,
    api: "openai-completions",
    baseUrl: CHAT_COMPLETIONS_URL,
    provider: "openrouter",
    reasoning: true,
    // OpenRouter takes low, medium and high for every reasoning model.
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    input: definition.images ? ["text", "image"] : ["text"],
    cost: {
      input: definition.inputCost,
      output: definition.outputCost,
      cacheRead: definition.cacheReadCost,
      cacheWrite: definition.cacheWriteCost,
    },
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "openrouter",
      supportsStrictMode: true,
      sendSessionAffinityHeaders: true,
    },
  } as Model<"openai-completions">;
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
