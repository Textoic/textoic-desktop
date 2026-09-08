import type { Provider } from "./providers/types.js";
import type {
  ChatMessage,
  CostEstimate,
  CostLine,
  ModelPricing,
} from "./types.js";
import { estimateMessageTokens } from "./util.js";

export interface PlannedCall {
  stage: string;
  messages?: ChatMessage[];
  inputTokens?: number;
  maxOutputTokens: number;
}

export const priceOf = (
  pricing: ModelPricing | null,
  inputTokens: number,
  outputTokens: number,
) =>
  pricing
    ? inputTokens * pricing.prompt + outputTokens * pricing.completion
    : 0;

export const lineFor = (
  pricing: ModelPricing | null,
  call: PlannedCall,
): CostLine => {
  const inputTokens =
    call.inputTokens ??
    (call.messages ? estimateMessageTokens(call.messages) : 0);
  return {
    stage: call.stage,
    inputTokens,
    outputTokens: call.maxOutputTokens,
    usd: priceOf(pricing, inputTokens, call.maxOutputTokens),
  };
};

export const estimateFor = async (
  provider: Provider,
  calls: PlannedCall[],
  note?: string,
): Promise<CostEstimate> => {
  const pricing = await provider.pricing();
  const breakdown = calls.map((call) => lineFor(pricing, call));
  return {
    provider: provider.kind,
    model: provider.model,
    calls: breakdown.length,
    inputTokens: breakdown.reduce((total, line) => total + line.inputTokens, 0),
    outputTokens: breakdown.reduce((total, line) => total + line.outputTokens, 0),
    usd: breakdown.reduce((total, line) => total + line.usd, 0),
    known: pricing !== null,
    breakdown,
    note,
  };
};

export const formatUsd = (usd: number) =>
  usd === 0 ? "$0.00" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
