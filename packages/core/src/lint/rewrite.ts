import { problemsInScope, type Scope } from "@textoic/enlint-lsp/fixes";
import {
  chunksWithProblems,
  cleanedAnswer,
  outputTokensFor,
  passageAround,
  rejectionOf,
  rewriteMessages,
  styleGuide,
} from "@textoic/enlint-lsp/rewrite";
import type { LintError } from "@textoic/enlint/types";
import type { ActionContext } from "../actions/context.js";
import type { PlannedCall } from "../cost.js";
import type { LintIssue, Rewrite } from "../types.js";
import type { LintService } from "./service.js";

export type { Rewrite, Scope };
export { styleGuide };

export interface RewriteRequest {
  text: string;
  start: number;
  end: number;
}

export const passageBounds = (text: string, start: number, end: number): [number, number] => {
  const span = passageAround(text, { start, end });
  return [span.start, span.end];
};

const messagesFor = (passage: string, issues: LintIssue[], offset: number) =>
  rewriteMessages({ guide: styleGuide, passage, problems: issues as LintError[], offset });

const wordsIn = (text: string) => (text.match(/\S+/gu) ?? []).length;

export const plannedRewriteCalls = async (request: RewriteRequest, issues: LintIssue[]): Promise<PlannedCall[]> => {
  const [from, to] = passageBounds(request.text, request.start, request.end);
  const passage = request.text.slice(from, to);
  const within = issues.filter((issue) => issue.start >= from && issue.end <= to);
  return [{ stage: "rewrite", messages: messagesFor(passage, within, from), maxOutputTokens: outputTokensFor(passage) }];
};

const issuesWithin = (issues: LintIssue[], from: number, to: number) => issues.filter((issue) => issue.start >= from && issue.end <= to);

const scoped = (issues: LintIssue[], scope: Scope) => problemsInScope(issues as LintError[], scope) as LintIssue[];

const partsWithIssues = (text: string, issues: LintIssue[]) => chunksWithProblems(text, issues as LintError[]);

export const plannedRewriteAllCalls = (text: string, allIssues: LintIssue[], scope: Scope = {}): PlannedCall[] => {
  const issues = scoped(allIssues, scope);
  return partsWithIssues(text, issues).map(({ start, end }, index) => {
    const passage = text.slice(start, end);
    return { stage: `rewrite part ${index + 1}`, messages: messagesFor(passage, issuesWithin(issues, start, end), start), maxOutputTokens: outputTokensFor(passage) };
  });
};

export const rewritePassage = async (ctx: ActionContext, lint: LintService, request: RewriteRequest): Promise<Rewrite> => {
  const [from, to] = passageBounds(request.text, request.start, request.end);
  const before = issuesWithin(await lint.lint(request.text), from, to);
  ctx.progress({ step: "rewriting passage", done: 0, total: 1 });
  const rewrite = await rewriteSpan(ctx, lint, request.text, [from, to], before);
  ctx.progress({ step: "rewrite ready", done: 1, total: 1 });
  return rewrite;
};

export const rewriteAllPassages = async (ctx: ActionContext, lint: LintService, text: string, scope: Scope = {}): Promise<Rewrite[]> => {
  const issues = scoped(await lint.lint(text), scope);
  const spans = partsWithIssues(text, issues);
  const rewrites: Rewrite[] = [];
  for (const [index, { start, end }] of spans.entries()) {
    ctx.progress({ step: `rewriting part ${index + 1} of ${spans.length}`, done: index, total: spans.length });
    rewrites.push(await rewriteSpan(ctx, lint, text, [start, end], issuesWithin(issues, start, end)));
  }

  ctx.progress({ step: "rewrites ready", done: spans.length, total: spans.length });
  return rewrites;
};

const rewriteSpan = async (ctx: ActionContext, lint: LintService, text: string, [from, to]: [number, number], before: LintIssue[]): Promise<Rewrite> => {
  const passage = text.slice(from, to);
  const result = await ctx.call("rewrite", {
    messages: messagesFor(passage, before, from),
    maxOutputTokens: outputTokensFor(passage),
    temperature: 0.3,
  });
  const replacement = cleanedAnswer(result.content);
  const after = replacement === "" ? [] : await lint.lint(replacement);
  const reason = rejectionOf({
    replacement,
    completion: { content: result.content, truncated: result.truncated },
    wordsBefore: wordsIn(passage),
    before: before as LintError[],
    after: after as LintError[],
  });
  return { start: from, end: to, original: passage, replacement, before, after, accepted: reason === undefined, reason };
};
