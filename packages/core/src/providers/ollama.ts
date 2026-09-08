import type { ModelInfo, ModelPricing } from "../types.js";
import {
  ProviderError,
  withoutReasoning,
  type ChatRequest,
  type ChatResult,
  type Provider,
} from "./types.js";

export interface OllamaOptions {
  baseUrl?: string;
  contextTokens?: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

type OllamaChat = {
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

type OllamaTags = {
  models?: {
    name?: string;
    details?: { parameter_size?: string; context_length?: number };
  }[];
};

const numberOf = (value: unknown) => (typeof value === "number" ? value : 0);

const isAbort = (cause: unknown) =>
  cause instanceof Error &&
  (cause.name === "AbortError" || cause.name === "TimeoutError");

export class OllamaProvider implements Provider {
  readonly kind = "ollama" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly contextTokens: number;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(model: string, options: OllamaOptions = {}) {
    this.model = model;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(
      /\/+$/u,
      "",
    );
    this.contextTokens = options.contextTokens ?? 32768;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const body = {
      model: this.model,
      messages: request.messages,
      stream: false,
      think: false,
      ...(request.json === undefined
        ? {}
        : { format: request.json === true ? "json" : request.json }),
      options: {
        num_ctx: this.contextTokens,
        num_predict: request.maxOutputTokens,
        temperature: request.temperature ?? 0.2,
      },
    };
    const response = await this.post("/api/chat", body, request.signal);
    const payload = (await response.json()) as OllamaChat;
    if (payload.error) {
      throw new ProviderError(`Ollama returned an error: ${payload.error}`);
    }

    const content = withoutReasoning(payload.message?.content ?? "");
    return {
      content,
      usage: {
        inputTokens: numberOf(payload.prompt_eval_count),
        outputTokens: numberOf(payload.eval_count),
      },
      costUsd: 0,
      model: this.model,
      provider: this.kind,
      finishReason: payload.done_reason,
      truncated: payload.done_reason === "length",
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.get("/api/tags");
    const payload = (await response.json()) as OllamaTags;
    return (payload.models ?? [])
      .filter((model) => typeof model.name === "string")
      .map((model) => ({
        id: model.name as string,
        name: `${model.name}${
          model.details?.parameter_size
            ? ` (${model.details.parameter_size})`
            : ""
        }`,
        provider: "ollama" as const,
        contextLength: model.details?.context_length,
        pricing: { prompt: 0, completion: 0 },
      }));
  }

  async pricing(): Promise<ModelPricing> {
    return { prompt: 0, completion: 0 };
  }

  private unreachable() {
    return new ProviderError(
      `Cannot reach Ollama at ${this.baseUrl}. Start it with \`ollama serve\` or change the Ollama URL in settings.`,
    );
  }

  private async get(path: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw this.unreachable();
    }

    if (!response.ok) {
      throw new ProviderError(
        `Ollama returned ${response.status} for ${path}: ${await response.text()}`,
      );
    }

    return response;
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (isAbort(cause)) {
        throw cause;
      }

      throw this.unreachable();
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new ProviderError(
        response.status === 404
          ? `Ollama has no model named "${this.model}". Pull it with \`ollama pull ${this.model}\` or pick another model.`
          : `Ollama returned ${response.status}: ${detail}`,
      );
    }

    return response;
  }
}
