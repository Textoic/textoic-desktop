import type { ModelInfo, ModelPricing } from "../types.js";
import {
  ProviderError,
  withoutReasoning,
  type ChatRequest,
  type ChatResult,
  type Provider,
} from "./types.js";

export interface OpenRouterOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  pricingOverride?: ModelPricing;
  timeoutMs?: number;
}

type Completion = {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  model?: string;
  error?: { message?: string };
};

type ModelsPayload = {
  data?: {
    id: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string };
  }[];
};

const numberOf = (value: unknown) => (typeof value === "number" ? value : 0);

const priceOf = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const isAbort = (cause: unknown) =>
  cause instanceof Error &&
  (cause.name === "AbortError" || cause.name === "TimeoutError");

let catalogue: { at: number; models: ModelInfo[] } | null = null;

const CATALOGUE_TTL_MS = 10 * 60 * 1000;

export const listOpenRouterModels = async (
  fetchFn: typeof fetch = fetch,
  baseUrl = "https://openrouter.ai/api/v1",
): Promise<ModelInfo[]> => {
  if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) {
    return catalogue.models;
  }

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ProviderError("Cannot reach OpenRouter to list models.");
  }

  if (!response.ok) {
    throw new ProviderError(
      `OpenRouter returned ${response.status} when listing models.`,
    );
  }

  const payload = (await response.json()) as ModelsPayload;
  const models = (payload.data ?? [])
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      provider: "openrouter" as const,
      contextLength: model.context_length,
      pricing: {
        prompt: priceOf(model.pricing?.prompt),
        completion: priceOf(model.pricing?.completion),
      },
    }))
    .sort((one, other) => one.name.localeCompare(other.name));
  catalogue = { at: Date.now(), models };
  return models;
};

export class OpenRouterProvider implements Provider {
  readonly kind = "openrouter" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pricingOverride?: ModelPricing;
  private readonly timeoutMs: number;
  private cachedPricing: ModelPricing | null = null;

  constructor(model: string, apiKey: string, options: OpenRouterOptions = {}) {
    if (!apiKey) {
      throw new ProviderError(
        "OpenRouter needs an API key. Add it in settings.",
        400,
      );
    }

    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.fetchFn = options.fetchFn ?? fetch;
    this.pricingOverride = options.pricingOverride;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature ?? 0.2,
      usage: { include: true },
    };
    if (request.json === true) {
      body.response_format = { type: "json_object" };
    } else if (request.json) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "answer", strict: false, schema: request.json },
      };
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "HTTP-Referer": "https://github.com/fpluis/textoic",
          "X-Title": "Textoic",
        },
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (isAbort(cause)) {
        throw cause;
      }

      throw new ProviderError("Cannot reach OpenRouter.");
    }

    if (!response.ok) {
      throw new ProviderError(
        `OpenRouter returned ${response.status}: ${await response.text()}`,
        response.status === 401 ? 401 : 502,
      );
    }

    const payload = (await response.json()) as Completion;
    if (payload.error?.message) {
      throw new ProviderError(`OpenRouter error: ${payload.error.message}`);
    }

    const choice = payload.choices?.[0];
    const content = withoutReasoning(choice?.message?.content ?? "");
    const inputTokens = numberOf(payload.usage?.prompt_tokens);
    const outputTokens = numberOf(payload.usage?.completion_tokens);
    const reported = payload.usage?.cost;
    const pricing = await this.pricing();
    const costUsd =
      typeof reported === "number"
        ? reported
        : pricing
          ? inputTokens * pricing.prompt + outputTokens * pricing.completion
          : null;
    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
        cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
        reasoningTokens:
          payload.usage?.completion_tokens_details?.reasoning_tokens,
      },
      costUsd,
      model: payload.model ?? this.model,
      provider: this.kind,
      finishReason: choice?.finish_reason,
      truncated: choice?.finish_reason === "length",
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return listOpenRouterModels(this.fetchFn, this.baseUrl);
  }

  async pricing(): Promise<ModelPricing | null> {
    if (this.pricingOverride) {
      return this.pricingOverride;
    }

    if (this.cachedPricing) {
      return this.cachedPricing;
    }

    try {
      const models = await listOpenRouterModels(this.fetchFn, this.baseUrl);
      const found = models.find((model) => model.id === this.model);
      this.cachedPricing = found?.pricing ?? null;
      return this.cachedPricing;
    } catch {
      return null;
    }
  }
}
