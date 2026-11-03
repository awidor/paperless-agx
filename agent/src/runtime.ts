import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { AgentRuntime } from "./agent.ts";
import type { AgentConfig } from "./config.ts";
import { PaperlessClient } from "./paperless.ts";

/** Connects the agent to OpenRouter through Pi, routed to zero-data-retention endpoints only. */
export function createRuntime(config: AgentConfig, overrides: { modelId?: string } = {}): AgentRuntime {
  const apiKey = process.env[config.model.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`${config.model.apiKeyEnv} is not set`);
  const modelId = overrides.modelId ?? config.model.id;
  const models = createModels();
  models.setProvider(openrouterProvider());
  const catalogModel = models.getModel("openrouter", modelId);
  if (!catalogModel) throw new Error(`OpenRouter model ${modelId} is not in Pi's model catalog`);
  const model = {
    ...catalogModel,
    compat: {
      ...catalogModel.compat,
      openRouterRouting: {
        ...(config.model.providers.length > 0 && !overrides.modelId ? { only: config.model.providers } : {}),
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
    reasoning: config.model.reasoning,
    maxTurns: config.maxTurns,
    timeoutMs: config.timeoutSeconds * 1000,
    maxResults: config.maxResults,
  };
}
