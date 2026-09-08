import type {
  ChatRequest,
  ChatResult,
  JsonSchema,
  Provider,
} from "../providers/types.js";
import { parseJsonLoosely, JsonParseError } from "../providers/json.js";
import type { AiCall, AiTrace, JobProgress, Settings } from "../types.js";
import { truncate } from "../util.js";

export type Validate<T> = (value: unknown) => T;

export interface ActionContext {
  readonly provider: Provider;
  readonly settings: Settings;
  readonly signal: AbortSignal;
  readonly trace: AiTrace;
  call(stage: string, request: Omit<ChatRequest, "signal">): Promise<ChatResult>;
  callJson<T>(
    stage: string,
    request: Omit<ChatRequest, "signal" | "json">,
    schema: JsonSchema,
    validate?: Validate<T>,
  ): Promise<T>;
  progress(progress: Partial<JobProgress> & { step: string }): void;
}

const OUTPUT_KEPT = 20_000;

export class TraceContext implements ActionContext {
  readonly provider: Provider;
  readonly settings: Settings;
  readonly signal: AbortSignal;
  readonly trace: AiTrace;
  private readonly onProgress: (progress: JobProgress) => void;
  private readonly onSpend: (usd: number) => void;
  private current: JobProgress = { step: "start", done: 0, total: 1 };

  constructor(options: {
    provider: Provider;
    settings: Settings;
    signal?: AbortSignal;
    onProgress?: (progress: JobProgress) => void;
    onSpend?: (usd: number) => void;
    params?: Record<string, unknown>;
  }) {
    this.provider = options.provider;
    this.settings = options.settings;
    this.signal = options.signal ?? new AbortController().signal;
    this.onProgress = options.onProgress ?? (() => undefined);
    this.onSpend = options.onSpend ?? (() => undefined);
    this.trace = {
      calls: [],
      totalUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      params: options.params,
    };
  }

  progress(progress: Partial<JobProgress> & { step: string }) {
    this.current = { ...this.current, ...progress };
    this.onProgress(this.current);
  }

  async call(stage: string, request: Omit<ChatRequest, "signal">): Promise<ChatResult> {
    if (this.signal.aborted) {
      throw new Error("The action was cancelled.");
    }

    const started = Date.now();
    const result = await this.provider.complete({ ...request, signal: this.signal });
    const pricing = await this.provider.pricing();
    const costUsd =
      result.costUsd ??
      (pricing
        ? result.usage.inputTokens * pricing.prompt +
          result.usage.outputTokens * pricing.completion
        : 0);
    const call: AiCall = {
      stage,
      provider: result.provider,
      model: result.model,
      messages: request.messages,
      params: {
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        json: request.json !== undefined,
      },
      usage: result.usage,
      costUsd,
      durationMs: Date.now() - started,
      finishReason: result.finishReason,
      output: truncate(result.content, OUTPUT_KEPT),
    };
    this.trace.calls.push(call);
    this.trace.totalUsd += costUsd;
    this.trace.totalInputTokens += result.usage.inputTokens;
    this.trace.totalOutputTokens += result.usage.outputTokens;
    this.onSpend(this.trace.totalUsd);
    return result;
  }

  async callJson<T>(
    stage: string,
    request: Omit<ChatRequest, "signal" | "json">,
    schema: JsonSchema,
    validate?: Validate<T>,
  ): Promise<T> {
    const check = validate ?? ((value: unknown) => value as T);
    const attempt = async (messages: ChatRequest["messages"]) => {
      const result = await this.call(stage, { ...request, messages, json: schema });
      return check(parseJsonLoosely(result.content));
    };

    try {
      return await attempt(request.messages);
    } catch (cause) {
      if (!(cause instanceof JsonParseError) && !(cause instanceof ValidationError)) {
        throw cause;
      }

      const reason =
        cause instanceof JsonParseError
          ? "That was not valid JSON."
          : `That JSON did not match the schema: ${cause.message}`;
      return attempt([
        ...request.messages,
        { role: "assistant", content: cause instanceof JsonParseError ? cause.raw.slice(0, 4000) : "(invalid)" },
        {
          role: "user",
          content: `${reason} Reply again with only a JSON object that matches this schema, nothing else:\n${JSON.stringify(schema)}`,
        },
      ]);
    }
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
