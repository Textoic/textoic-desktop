import type { ProviderChoice } from "../providers/index.js";
import type { Provider } from "../providers/types.js";
import type { Actor, CostEstimate, Job, Settings } from "../types.js";
import { now, TextoicError } from "../util.js";
import { TraceContext } from "./context.js";
import type { ActionDefinition, ActionDeps, ActionOutcome } from "./definitions.js";
import type { JobRegistry } from "./jobs.js";

export interface StartOptions {
  sessionId: string;
  params?: Record<string, unknown>;
  choice?: ProviderChoice;
}

export type ProviderFactory = (settings: Settings, choice: ProviderChoice) => Provider;

export class ActionRunner {
  private readonly deps: ActionDeps;
  private readonly jobs: JobRegistry;
  private readonly factory: ProviderFactory;
  private readonly definitions = new Map<string, ActionDefinition>();

  constructor(deps: ActionDeps, jobs: JobRegistry, factory: ProviderFactory) {
    this.deps = deps;
    this.jobs = jobs;
    this.factory = factory;
  }

  register(definition: ActionDefinition) {
    this.definitions.set(definition.name, definition);
  }

  list() {
    return [...this.definitions.values()].map(({ name, describe }) => ({ name, describe }));
  }

  definition(name: string): ActionDefinition {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new TextoicError(`Unknown action ${name}.`, 404);
    }

    return definition;
  }

  async provider(choice: ProviderChoice = {}): Promise<Provider> {
    return this.factory(await this.deps.settings(), choice);
  }

  async estimate(name: string, options: StartOptions): Promise<CostEstimate> {
    const definition = this.definition(name);
    const provider = await this.provider(options.choice);
    return definition.estimate(this.deps, provider, options.sessionId, options.params ?? {});
  }

  async start(name: string, options: StartOptions): Promise<Job> {
    const definition = this.definition(name);
    const settings = await this.deps.settings();
    const provider = this.factory(settings, options.choice ?? {});
    const params = options.params ?? {};
    const estimate = await definition.estimate(this.deps, provider, options.sessionId, params);
    const job = this.jobs.create(name, options.sessionId, estimate);
    const ctx = new TraceContext({
      provider,
      settings,
      signal: this.jobs.signal(job.id),
      onProgress: (progress) => this.jobs.progress(job.id, progress),
      onSpend: (usd) => this.jobs.spend(job.id, usd),
      params: sanitize(params),
    });
    ctx.trace.estimate = estimate;
    void this.execute(job, definition, ctx, options.sessionId, params);
    return job;
  }

  private async execute(job: Job, definition: ActionDefinition, ctx: TraceContext, sessionId: string, params: Record<string, unknown>) {
    const actor: Actor = { kind: "ai", provider: ctx.provider.kind, model: ctx.provider.model };
    this.jobs.update(job.id, { status: "running", startedAt: now(), progress: { step: "starting", done: 0, total: 1 } });
    try {
      const outcome = await definition.run(ctx, this.deps, sessionId, params);
      const documentIds = await this.applyDocuments(outcome, sessionId, actor, ctx);
      let auditEntryId: string | undefined;
      if (documentIds.length === 0 && !outcome.action?.startsWith("novel.")) {
        const entry = await this.deps.audit.record({ sessionId, actor, action: outcome.action ?? definition.name, summary: outcome.summary, target: outcome.target, ai: ctx.trace });
        auditEntryId = entry.id;
      }

      this.jobs.update(job.id, {
        status: "done",
        finishedAt: now(),
        spentUsd: ctx.trace.totalUsd,
        result: { ...(outcome.result ?? {}), summary: outcome.summary, documentIds },
        auditEntryId,
      });
    } catch (cause) {
      const cancelled = ctx.signal.aborted;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (ctx.trace.calls.length > 0) {
        await this.deps.audit.record({
          sessionId,
          actor,
          action: `${definition.name}.${cancelled ? "cancelled" : "failed"}`,
          summary: cancelled ? `Cancelled ${definition.name} after ${ctx.trace.calls.length} call(s)` : `${definition.name} failed: ${message}`,
          ai: ctx.trace,
        });
      }

      this.jobs.update(job.id, {
        status: cancelled ? "cancelled" : "failed",
        finishedAt: now(),
        spentUsd: ctx.trace.totalUsd,
        error: cancelled ? "Cancelled." : message,
      });
    }
  }

  private async applyDocuments(outcome: ActionOutcome, sessionId: string, actor: Actor, ctx: TraceContext): Promise<string[]> {
    const ids: string[] = [];
    for (const write of outcome.documents ?? []) {
      const meta = { actor, action: write.action ?? outcome.action, summary: write.summary ?? outcome.summary, ai: ctx.trace };
      const document = write.documentId
        ? await this.deps.sessions.updateDocument(sessionId, write.documentId, { content: write.content, title: write.title }, meta)
        : await this.deps.sessions.createDocument(sessionId, { title: write.title, content: write.content, kind: write.kind }, meta);
      ids.push(document.id);
    }

    return ids;
  }
}

const sanitize = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === "string" && value.length > 2000 ? `${value.slice(0, 2000)}…` : value,
    ]),
  );
