import type { AuditService } from "../audit/service.js";
import { assembleContext, contextPreamble } from "../context/assemble.js";
import { digestItem, plannedDigestCalls } from "../context/digest.js";
import { cachedBrief, explore } from "../context/explorer.js";
import type { ContextService } from "../context/store.js";
import { estimateFor, type PlannedCall } from "../cost.js";
import { plannedFactCheckCalls, type FactCheckService } from "../factcheck/service.js";
import { plannedRewriteCalls, rewritePassage } from "../lint/rewrite.js";
import type { LintService } from "../lint/service.js";
import type { Provider } from "../providers/types.js";
import type { ResearchService } from "../research/service.js";
import type { SessionService } from "../sessions/service.js";
import type { Storage } from "../storage/storage.js";
import { ARTICLE_MAX_WORDS, ARTICLE_MIN_WORDS, generateArticle, plannedArticleCalls } from "../templates/article.js";
import { generateBlueprintSteps, plannedBlueprintCalls, remainingSteps } from "../templates/novel/blueprint.js";
import { generateChapter, plannedChapterCalls } from "../templates/novel/chapter.js";
import { generateTweet, plannedTweetCalls, PROMPT_MAX_CHARS } from "../templates/tweet.js";
import {
  BLUEPRINT_STEPS,
  type AuditEntry,
  type BlueprintStep,
  type CostEstimate,
  type DocumentKind,
  type NovelState,
  type ResearchEffort,
  type Settings,
} from "../types.js";
import { clamp, TextoicError } from "../util.js";
import type { ActionContext } from "./context.js";

export interface ActionDeps {
  storage: Storage;
  settings: () => Promise<Settings>;
  sessions: SessionService;
  context: ContextService;
  audit: AuditService;
  lint: LintService;
  research: ResearchService;
  factcheck: FactCheckService;
}

export interface DocumentWrite {
  documentId?: string;
  title?: string;
  content: string;
  kind?: DocumentKind;
  action?: string;
  summary?: string;
}

export interface ActionOutcome {
  summary: string;
  action?: string;
  target?: AuditEntry["target"];
  result?: Record<string, unknown>;
  documents?: DocumentWrite[];
}

export interface ActionDefinition<P = Record<string, unknown>> {
  name: string;
  describe: string;
  estimate(deps: ActionDeps, provider: Provider, sessionId: string, params: P): Promise<CostEstimate>;
  run(ctx: ActionContext, deps: ActionDeps, sessionId: string, params: P): Promise<ActionOutcome>;
}

type Params = Record<string, unknown>;

const stringParam = (params: Params, key: string, fallback = ""): string =>
  typeof params[key] === "string" ? (params[key] as string) : fallback;

const numberParam = (params: Params, key: string, fallback: number): number =>
  typeof params[key] === "number" && Number.isFinite(params[key] as number) ? (params[key] as number) : fallback;

const promptOf = (params: Params) => {
  const prompt = stringParam(params, "prompt").trim();
  if (prompt === "") {
    throw new TextoicError("Write a prompt first.", 400);
  }

  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new TextoicError(`Prompts are limited to ${PROMPT_MAX_CHARS} characters.`, 400);
  }

  return prompt;
};

const contextFor = async (deps: ActionDeps, provider: Provider, sessionId: string, query: string, excludeItemIds: string[] = []) => {
  const settings = await deps.settings();
  const assembled = await assembleContext(deps.context, {
    sessionId,
    query,
    budgetTokens: settings.contextBudgetTokens,
    model: provider.model,
    excludeItemIds,
  });
  return { preamble: contextPreamble(assembled), assembled };
};

const noteFor = (used: { mode: string }[], totalItems: number) =>
  totalItems === 0
    ? "No session context attached."
    : `Context: ${used.filter((one) => one.mode === "full").length} item(s) in full, ${used.filter((one) => one.mode !== "full").length} summarised or excerpted, out of ${totalItems}.`;

export const tweetAction: ActionDefinition = {
  name: "generate.tweet",
  describe: "Write a single-idea tweet of at most 280 characters from a prompt.",
  async estimate(deps, provider, sessionId, params) {
    const prompt = promptOf(params);
    const { preamble, assembled } = await contextFor(deps, provider, sessionId, prompt);
    return estimateFor(provider, plannedTweetCalls(prompt, preamble), noteFor(assembled.used, assembled.totalItems));
  },
  async run(ctx, deps, sessionId, params) {
    const prompt = promptOf(params);
    const { preamble } = await contextFor(deps, ctx.provider, sessionId, prompt);
    const tweet = await generateTweet(ctx, prompt, preamble);
    const documentId = stringParam(params, "documentId") || undefined;
    return {
      summary: `Generated a tweet (${tweet.length} characters)`,
      action: "generate.tweet",
      result: { text: tweet, characters: tweet.length },
      documents: [{ documentId, title: documentId ? undefined : "Tweet", content: tweet, kind: "text", action: "generate.tweet", summary: `AI wrote a tweet (${tweet.length} characters)` }],
    };
  },
};

const articleRange = (params: Params): [number, number] => {
  const min = clamp(Math.round(numberParam(params, "minWords", ARTICLE_MIN_WORDS)), ARTICLE_MIN_WORDS, ARTICLE_MAX_WORDS);
  const max = clamp(Math.round(numberParam(params, "maxWords", ARTICLE_MAX_WORDS)), min, ARTICLE_MAX_WORDS);
  return [min, max];
};

export const articleAction: ActionDefinition = {
  name: "generate.article",
  describe: "Plan and draft an article of 500 to 1000 words from a prompt.",
  async estimate(deps, provider, sessionId, params) {
    const prompt = promptOf(params);
    const [min, max] = articleRange(params);
    const { preamble, assembled } = await contextFor(deps, provider, sessionId, prompt);
    return estimateFor(provider, plannedArticleCalls(prompt, min, max, preamble), noteFor(assembled.used, assembled.totalItems));
  },
  async run(ctx, deps, sessionId, params) {
    const prompt = promptOf(params);
    const [min, max] = articleRange(params);
    const { preamble } = await contextFor(deps, ctx.provider, sessionId, prompt);
    const article = await generateArticle(ctx, prompt, min, max, preamble);
    const documentId = stringParam(params, "documentId") || undefined;
    return {
      summary: `Generated an article of ${article.words} words`,
      action: "generate.article",
      result: { title: article.title, words: article.words },
      documents: [{ documentId, title: article.title, content: article.markdown, kind: "markdown", action: "generate.article", summary: `AI drafted "${article.title}" (${article.words} words)` }],
    };
  },
};

const novelOf = async (deps: ActionDeps, sessionId: string): Promise<NovelState> => {
  const session = await deps.sessions.get(sessionId);
  if (!session.novel) {
    throw new TextoicError("This session is not a novel session.", 400);
  }

  return session.novel;
};

const stepsOf = (params: Params, novel: NovelState): BlueprintStep[] => {
  const requested = Array.isArray(params.steps)
    ? (params.steps as unknown[]).filter((step): step is BlueprintStep => BLUEPRINT_STEPS.includes(step as BlueprintStep))
    : [];
  const steps = requested.length > 0 ? requested : remainingSteps(novel.blueprint);
  if (steps.length === 0) {
    throw new TextoicError("The blueprint is complete. Pick a section to regenerate, or generate the test chapter.", 400);
  }

  return BLUEPRINT_STEPS.filter((step) => steps.includes(step));
};

export const blueprintAction: ActionDefinition = {
  name: "novel.blueprint",
  describe: "Generate the missing (or chosen) sections of the novel blueprint.",
  async estimate(deps, provider, sessionId, params) {
    const novel = await novelOf(deps, sessionId);
    const steps = stepsOf(params, novel);
    return estimateFor(provider, plannedBlueprintCalls(novel.settings, novel.blueprint, steps), `Steps: ${steps.join(", ")}. Chapter outlines depend on how many parts the model plans.`);
  },
  async run(ctx, deps, sessionId, params) {
    const novel = await novelOf(deps, sessionId);
    const steps = stepsOf(params, novel);
    const blueprint = await generateBlueprintSteps(ctx, novel.settings, novel.blueprint, steps, async (progress) => {
      await deps.sessions.saveNovelProgress(sessionId, { ...novel, blueprint: progress, approved: false });
    });
    await deps.sessions.setNovel(
      sessionId,
      { ...novel, blueprint, approved: false },
      { actor: { kind: "ai", provider: ctx.provider.kind, model: ctx.provider.model }, action: "novel.blueprint", summary: `AI generated blueprint sections: ${steps.join(", ")}`, ai: ctx.trace },
      novel,
    );
    return { summary: `Generated blueprint sections: ${steps.join(", ")}`, action: "novel.blueprint", target: { type: "blueprint", id: sessionId, title: "Novel blueprint" }, result: { steps } };
  },
};

export const testChapterAction: ActionDefinition = {
  name: "novel.testChapter",
  describe: "Write chapter one from the approved blueprint to preview the novel's voice.",
  async estimate(deps, provider, sessionId) {
    const novel = await novelOf(deps, sessionId);
    if (remainingSteps(novel.blueprint).length > 0) {
      throw new TextoicError("Finish the blueprint before generating a test chapter.", 400);
    }

    return estimateFor(provider, plannedChapterCalls(novel.settings, novel.blueprint), "Scene count depends on the chapter outline the model produces.");
  },
  async run(ctx, deps, sessionId) {
    const novel = await novelOf(deps, sessionId);
    if (remainingSteps(novel.blueprint).length > 0) {
      throw new TextoicError("Finish the blueprint before generating a test chapter.", 400);
    }

    const chapter = await generateChapter(ctx, novel.settings, novel.blueprint);
    const document = await deps.sessions.createDocument(
      sessionId,
      { title: `Chapter 1: ${chapter.title}`, content: chapter.markdown, kind: "markdown" },
      { actor: { kind: "ai", provider: ctx.provider.kind, model: ctx.provider.model }, action: "novel.testChapter", summary: `AI wrote the test chapter "${chapter.title}" (${chapter.scenes.length} scenes)`, ai: ctx.trace },
    );
    await deps.sessions.saveNovelProgress(sessionId, { ...novel, testChapter: { documentId: document.id, outline: chapter.outline, at: new Date().toISOString() } });
    return { summary: `Wrote test chapter "${chapter.title}"`, action: "novel.testChapter", target: { type: "document", id: document.id, title: document.title }, result: { documentId: document.id, scenes: chapter.scenes.length } };
  },
};

const effortOf = (value: unknown, fallback: ResearchEffort): ResearchEffort =>
  value === "low" || value === "medium" || value === "high" ? value : fallback;

export const researchAction: ActionDefinition = {
  name: "research.run",
  describe: "Run budget-bounded deep research on a topic and attach the report as context.",
  async estimate(deps, provider, _sessionId, params) {
    const settings = await deps.settings();
    const topic = stringParam(params, "topic").trim();
    if (topic === "") {
      throw new TextoicError("Give the research a topic.", 400);
    }

    const budgetUsd = Math.max(0, numberParam(params, "budgetUsd", settings.research.budgetUsd));
    const effort = effortOf(params.effort, settings.research.effort);
    const queries = effort === "low" ? 2 : effort === "medium" ? 4 : 6;
    const calls: PlannedCall[] = [{ stage: "research report", inputTokens: 6000 + queries * 3000, maxOutputTokens: 4096 }];
    const estimate = await estimateFor(provider, calls, `Research spends at most $${budgetUsd.toFixed(2)} on inference (hard cap enforced by the research engine); ${queries} searches at ${effort} effort. Search itself is free with SearXNG, or billed per query with Serper.`);
    return provider.kind === "openrouter" ? { ...estimate, usd: Math.min(Math.max(estimate.usd, 0), budgetUsd || estimate.usd) } : estimate;
  },
  async run(ctx, deps, sessionId, params) {
    const settings = ctx.settings;
    const record = await deps.research.run(ctx, sessionId, {
      topic: stringParam(params, "topic"),
      budgetUsd: Math.max(0, numberParam(params, "budgetUsd", settings.research.budgetUsd)),
      effort: effortOf(params.effort, settings.research.effort),
    });
    return {
      summary: `Researched "${record.topic}" (${record.sources} sources, ${record.stopReason})`,
      action: "research.run",
      target: { type: "research", id: record.id, title: record.topic },
      result: { record },
    };
  },
};

export const factCheckAction: ActionDefinition = {
  name: "factcheck.run",
  describe: "Extract the document's factual claims and check them against the session context.",
  async estimate(deps, provider, sessionId, params) {
    const document = await deps.sessions.getDocument(sessionId, stringParam(params, "documentId"));
    if (document.content.trim() === "") {
      throw new TextoicError("The document is empty.", 400);
    }

    const hasResearch = await deps.research.hasResearch(sessionId);
    return estimateFor(provider, plannedFactCheckCalls(document), hasResearch ? undefined : "No research report in the session context: claims will be judged only against the other attached items.");
  },
  async run(ctx, deps, sessionId, params) {
    const document = await deps.sessions.getDocument(sessionId, stringParam(params, "documentId"));
    const run = await deps.factcheck.run(ctx, sessionId, document);
    const contradicted = run.findings.filter((finding) => finding.verdict === "contradicted").length;
    return {
      summary: `Fact-checked "${document.title}": ${run.claims} claims, ${contradicted} contradicted`,
      action: "factcheck.run",
      target: { type: "factcheck", id: run.id, title: document.title },
      result: { runId: run.id, claims: run.claims, contradicted, findings: run.findings },
    };
  },
};

export const digestAction: ActionDefinition = {
  name: "context.digest",
  describe: "Write a reusable one-paragraph reference card for each context item lacking one.",
  async estimate(deps, provider, sessionId, params) {
    const wanted = Array.isArray(params.itemIds) ? new Set(params.itemIds as string[]) : null;
    const items = (await deps.context.itemsFor(sessionId)).filter((item) => wanted === null || wanted.has(item.id));
    const calls = await plannedDigestCalls(deps.context, items, provider.model);
    return estimateFor(provider, calls, calls.length === 0 ? "Every item already has a digest for this model." : `${calls.length} item(s) to digest; digests are cached by content and model, so they are never regenerated.`);
  },
  async run(ctx, deps, sessionId, params) {
    const wanted = Array.isArray(params.itemIds) ? new Set(params.itemIds as string[]) : null;
    const items = (await deps.context.itemsFor(sessionId)).filter((item) => wanted === null || wanted.has(item.id));
    const pending = items.filter((item) => !item.digests[ctx.provider.model]);
    for (const [index, item] of pending.entries()) {
      ctx.progress({ step: `digesting ${item.name}`, done: index, total: pending.length });
      await digestItem(ctx, deps.context, item);
    }

    ctx.progress({ step: "digests ready", done: pending.length, total: pending.length });
    return { summary: `Digested ${pending.length} context item(s)`, action: "context.digest", result: { digested: pending.map((item) => item.id) } };
  },
};

export const exploreAction: ActionDefinition = {
  name: "context.explore",
  describe: "Let the model explore the attached context like a codebase and write a brief for a task.",
  async estimate(deps, provider, sessionId, params) {
    const task = stringParam(params, "task").trim();
    if (task === "") {
      throw new TextoicError("Describe the task the brief is for.", 400);
    }

    const cached = await cachedBrief(deps.storage, deps.context, { sessionId, task }, provider.model);
    if (cached) {
      return estimateFor(provider, [], "A brief for this task and context already exists; nothing will be spent.");
    }

    const steps = 12;
    return estimateFor(provider, Array.from({ length: steps }, (_, index) => ({ stage: `explore step ${index + 1}`, inputTokens: 1500 + index * 1500, maxOutputTokens: 1200 })), `Upper bound: at most ${steps} exploration steps; the model usually finishes earlier.`);
  },
  async run(ctx, deps, sessionId, params) {
    const brief = await explore(ctx, deps.storage, deps.context, { sessionId, task: stringParam(params, "task") });
    return { summary: brief.cached ? "Reused a cached context brief" : `Explored the context in ${brief.steps} steps and wrote a brief`, action: "context.explore", result: { brief: brief.text, cached: brief.cached, steps: brief.steps } };
  },
};

export const rewriteAction: ActionDefinition = {
  name: "lint.rewrite",
  describe: "Rewrite the selected passage to fix the style issues the linter found.",
  async estimate(deps, provider, sessionId, params) {
    const document = await deps.sessions.getDocument(sessionId, stringParam(params, "documentId"));
    const issues = await deps.lint.lint(document.content);
    const calls = await plannedRewriteCalls({ text: document.content, start: numberParam(params, "start", 0), end: numberParam(params, "end", 0) }, issues);
    return estimateFor(provider, calls);
  },
  async run(ctx, deps, sessionId, params) {
    const document = await deps.sessions.getDocument(sessionId, stringParam(params, "documentId"));
    const rewrite = await rewritePassage(ctx, deps.lint, { text: document.content, start: numberParam(params, "start", 0), end: numberParam(params, "end", 0) });
    return {
      summary: rewrite.accepted ? `Proposed a rewrite fixing ${rewrite.before.length - rewrite.after.length} of ${rewrite.before.length} issues` : `Rewrite rejected: ${rewrite.reason}`,
      action: "lint.rewrite",
      target: { type: "document", id: document.id, title: document.title },
      result: { rewrite: { ...rewrite, documentId: document.id, documentHash: document.contentHash } },
    };
  },
};

export const builtinActions: ActionDefinition[] = [
  tweetAction,
  articleAction,
  blueprintAction,
  testChapterAction,
  researchAction,
  factCheckAction,
  digestAction,
  exploreAction,
  rewriteAction,
];
