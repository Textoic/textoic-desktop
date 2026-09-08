import { join } from "node:path";
import {
  FallbackSearchProvider,
  FileRunStore,
  ResearchClient,
  SearxngSearchProvider,
  SerperSearchProvider,
  type ChatRequest as ResearchChatRequest,
  type ChatResult as ResearchChatResult,
  type CostEstimate as ResearchCostEstimate,
  type InferenceProvider,
  type ResearchRun,
  type SearchProvider,
} from "budget-researcher";
import type { ActionContext } from "../actions/context.js";
import type { ContextService } from "../context/store.js";
import type { Storage } from "../storage/storage.js";
import type { ResearchEffort, ResearchRecord, Settings } from "../types.js";
import { estimateMessageTokens, id, now, TextoicError } from "../util.js";

export interface ResearchRequest {
  topic: string;
  budgetUsd: number;
  effort: ResearchEffort;
  maxOutputTokens?: number;
}

const providerAdapter = (ctx: ActionContext): InferenceProvider => ({
  kind: ctx.provider.kind,
  model: ctx.provider.model,
  async estimateCost(request: ResearchChatRequest): Promise<ResearchCostEstimate> {
    const pricing = await ctx.provider.pricing();
    const inputTokens = estimateMessageTokens(request.messages);
    return {
      usd: pricing ? inputTokens * pricing.prompt + request.maxOutputTokens * pricing.completion : 0,
      inputTokens,
      outputTokens: request.maxOutputTokens,
      known: pricing !== null,
    };
  },
  async complete(request: ResearchChatRequest): Promise<ResearchChatResult> {
    const result = await ctx.call("research", {
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
      ...(request.responseFormat === "json" ? { json: true as const } : {}),
    });
    return {
      content: result.content,
      usage: result.usage,
      costUsd: result.costUsd ?? undefined,
      model: result.model,
      provider: ctx.provider.kind,
      finishReason: result.finishReason,
    };
  },
});

export const searchProviderFrom = (settings: Settings): SearchProvider | undefined => {
  const searxng = settings.searxngUrl ? new SearxngSearchProvider({ baseUrl: settings.searxngUrl }) : null;
  const serper = settings.serperKey ? new SerperSearchProvider({ apiKey: settings.serperKey }) : null;
  if (serper && searxng) {
    return new FallbackSearchProvider([
      { id: "serper", provider: serper },
      { id: "searxng", provider: searxng },
    ]);
  }

  return serper ?? searxng ?? undefined;
};

const summaryOf = (run: ResearchRun) =>
  `Research report on "${run.topic}" (${run.sources.length} sources, ${run.stopReason})`;

export class ResearchService {
  private readonly storage: Storage;
  private readonly context: ContextService;
  private readonly runsDir: string;

  constructor(storage: Storage, context: ContextService, dataDir: string) {
    this.storage = storage;
    this.context = context;
    this.runsDir = join(dataDir, "research-runs");
  }

  list(sessionId: string) {
    return this.storage.research.list(sessionId);
  }

  async hasResearch(sessionId: string): Promise<boolean> {
    const items = await this.context.itemsFor(sessionId);
    return items.some((item) => item.kind === "research");
  }

  async run(ctx: ActionContext, sessionId: string, request: ResearchRequest): Promise<ResearchRecord> {
    const topic = request.topic.trim();
    if (topic === "") {
      throw new TextoicError("Give the research a topic.", 400);
    }

    const search = searchProviderFrom(ctx.settings);
    ctx.progress({
      step: "researching",
      done: 0,
      total: 1,
      message: search ? `Searching the web and reading sources (${request.effort} effort)` : "No search provider configured; the report will rely on the model alone",
    });
    const client = new ResearchClient({
      provider: providerAdapter(ctx),
      searchProvider: search,
      store: new FileRunStore(this.runsDir),
    });
    const run = await client.researchTopic({
      topic,
      budgetUsd: request.budgetUsd,
      effort: request.effort,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
    });

    ctx.progress({ step: "saving report", done: 1, total: 1 });
    const item = await this.context.ingestText({
      name: `Research: ${topic.slice(0, 70)}`,
      text: run.reportMarkdown,
      kind: "research",
      source: { type: "research", runId: run.id, topic },
    });
    await this.context.attach(sessionId, [item.id], summaryOf(run));
    const record: ResearchRecord = {
      id: run.id,
      sessionId,
      topic,
      effort: request.effort,
      budgetUsd: request.budgetUsd,
      spentUsd: run.ledger.spentUsd,
      stopReason: run.stopReason,
      at: now(),
      contextItemId: item.id,
      sources: run.sources.length,
      limitations: run.limitations,
      model: ctx.provider.model,
      provider: ctx.provider.kind,
    };
    await this.storage.research.put(record);
    return record;
  }
}

export const researchRecordId = () => id();
