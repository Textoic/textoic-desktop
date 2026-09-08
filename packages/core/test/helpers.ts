import type { ChatRequest, ChatResult, Provider } from "../src/providers/types.js";
import type { ModelInfo, ModelPricing } from "../src/types.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { Textoic } from "../src/engine.js";

export type Script = (request: ChatRequest, calls: number) => string | Promise<string>;

export class FakeProvider implements Provider {
  readonly kind = "openrouter" as const;
  readonly model: string;
  readonly requests: ChatRequest[] = [];
  private readonly script: Script;
  private readonly price: ModelPricing;

  constructor(script: Script, model = "fake/model", price: ModelPricing = { prompt: 0.000001, completion: 0.000002 }) {
    this.script = script;
    this.model = model;
    this.price = price;
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(request);
    const content = await this.script(request, this.requests.length);
    const inputTokens = Math.ceil(request.messages.reduce((total, message) => total + message.content.length, 0) / 4);
    const outputTokens = Math.ceil(content.length / 4);
    return {
      content,
      usage: { inputTokens, outputTokens },
      costUsd: inputTokens * this.price.prompt + outputTokens * this.price.completion,
      model: this.model,
      provider: this.kind,
      finishReason: "stop",
      truncated: false,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.model, name: this.model, provider: this.kind, pricing: this.price }];
  }

  async pricing(): Promise<ModelPricing> {
    return this.price;
  }
}

export const lastUserMessage = (request: ChatRequest) =>
  [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";

export const engineWith = (provider: Provider) =>
  new Textoic({ storage: new MemoryStorage(), dataDir: "data-test", providerFactory: () => provider });

export const waitForJob = async (engine: Textoic, jobId: string, timeoutMs = 10_000) => {
  const started = Date.now();
  for (;;) {
    const job = engine.jobs.get(jobId);
    if (job && (job.status === "done" || job.status === "failed" || job.status === "cancelled")) {
      return job;
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`Job ${jobId} did not finish in time.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
