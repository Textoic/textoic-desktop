import type {
  ChatMessage,
  ModelInfo,
  ModelPricing,
  ProviderKind,
  TokenUsage,
} from "../types.js";

export type JsonSchema = Record<string, unknown>;

export interface ChatRequest {
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  json?: JsonSchema | true;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage;
  costUsd: number | null;
  model: string;
  provider: ProviderKind;
  finishReason?: string;
  truncated: boolean;
}

export interface Provider {
  readonly kind: ProviderKind;
  readonly model: string;
  complete(request: ChatRequest): Promise<ChatResult>;
  listModels(): Promise<ModelInfo[]>;
  pricing(): Promise<ModelPricing | null>;
}

export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export const withoutReasoning = (content: string) =>
  content.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
