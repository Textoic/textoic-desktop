import type {
  ModelInfo,
  ModelPricing,
  ProviderKind,
  Settings,
} from "../types.js";
import { OllamaProvider } from "./ollama.js";
import { OpenRouterProvider, listOpenRouterModels } from "./openrouter.js";
import { ProviderError, type Provider } from "./types.js";

export type {
  ChatRequest,
  ChatResult,
  JsonSchema,
  Provider,
} from "./types.js";
export { ProviderError, withoutReasoning } from "./types.js";
export { OllamaProvider } from "./ollama.js";
export { OpenRouterProvider } from "./openrouter.js";
export { parseJsonLoosely, JsonParseError } from "./json.js";

export interface ProviderChoice {
  provider?: ProviderKind;
  model?: string;
}

export const pricingFor = (
  settings: Settings,
  provider: ProviderKind,
  model: string,
): ModelPricing | undefined =>
  settings.pricingOverrides[`${provider}:${model}`] ??
  settings.pricingOverrides[model];

export const providerFrom = (
  settings: Settings,
  choice: ProviderChoice = {},
  fetchFn: typeof fetch = fetch,
): Provider => {
  const kind = choice.provider ?? settings.provider;
  const model = choice.model ?? settings.model;
  if (!model) {
    throw new ProviderError(
      "Pick a model in settings before running AI actions.",
      400,
    );
  }

  if (kind === "ollama") {
    return new OllamaProvider(model, {
      baseUrl: settings.ollamaUrl,
      contextTokens: settings.ollamaContextTokens,
      fetchFn,
    });
  }

  return new OpenRouterProvider(model, settings.openrouterKey, {
    fetchFn,
    pricingOverride: pricingFor(settings, kind, model),
  });
};

export const listModels = async (
  settings: Settings,
  kind: ProviderKind,
  fetchFn: typeof fetch = fetch,
): Promise<ModelInfo[]> => {
  if (kind === "ollama") {
    const probe = new OllamaProvider("probe", {
      baseUrl: settings.ollamaUrl,
      fetchFn,
    });
    return probe.listModels();
  }

  return listOpenRouterModels(fetchFn);
};
