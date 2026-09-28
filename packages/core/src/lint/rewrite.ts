import {
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

export type { Rewrite };
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

export const rewritePassage = async (ctx: ActionContext, lint: LintService, request: RewriteRequest): Promise<Rewrite> => {
  const [from, to] = passageBounds(request.text, request.start, request.end);
  const passage = request.text.slice(from, to);
  const all = await lint.lint(request.text);
  const before = all.filter((issue) => issue.start >= from && issue.end <= to);
  ctx.progress({ step: "rewriting passage", done: 0, total: 1 });
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
  ctx.progress({ step: "rewrite ready", done: 1, total: 1 });
  return { start: from, end: to, original: passage, replacement, before, after, accepted: reason === undefined, reason };
};
