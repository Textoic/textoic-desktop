import { readFile } from "node:fs/promises";
import type { ActionContext } from "../actions/context.js";
import type { PlannedCall } from "../cost.js";
import type { ChatMessage, LintIssue, Rewrite } from "../types.js";
import type { LintService } from "./service.js";

export type { Rewrite };

export interface RewriteRequest {
  text: string;
  start: number;
  end: number;
}

let guide: Promise<string> | null = null;

export const styleGuide = () => {
  guide ??= readFile(new URL("../../assets/style-guide.md", import.meta.url), "utf8");
  return guide;
};

export const passageBounds = (text: string, start: number, end: number): [number, number] => {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(text.length, Math.max(start, end));
  const paragraphStart = text.lastIndexOf("\n\n", Math.max(0, from - 1));
  const paragraphEnd = text.indexOf("\n\n", to);
  return [paragraphStart === -1 ? 0 : paragraphStart + 2, paragraphEnd === -1 ? text.length : paragraphEnd];
};

const describe = (passage: string, issue: LintIssue, offset: number) => {
  const span = passage.slice(issue.start - offset, issue.end - offset).replace(/\s+/gu, " ");
  const swaps = (issue.suggestions ?? [])
    .filter(({ range: [from, to] }) => from === issue.start && to === issue.end)
    .map(({ text }) => text)
    .filter((text) => text !== "");
  return `- "${span}" — ${issue.message}${swaps.length > 0 ? `\n  Replacements the rule offers: ${swaps.join(", ")}` : ""}`;
};

export const rewriteMessages = (guideText: string, passage: string, issues: LintIssue[], offset: number): ChatMessage[] => [
  {
    role: "system",
    content: `You are an English style editor. You are given a passage, the style guide you edit by, and the problems a linter found in it. Fix every listed problem, and bring the surrounding sentence in line with the guide while you are there. Change as little as you can: every word the problems do not reach comes through untouched and in the same order. Keep the meaning, tense, register and the Markdown formatting. Return only the edited passage: no preamble, no notes, no quotation marks or code fences around it.

The style guide:

${guideText}`,
  },
  {
    role: "user",
    content: `The passage to edit:\n\n${passage}\n\nProblems the linter found:\n${
      issues.length === 0 ? "None listed. Apply the style guide and change nothing else." : issues.map((issue) => describe(passage, issue, offset)).join("\n")
    }\n\nReturn the edited passage and nothing else.`,
  },
];

const outputTokensFor = (passage: string) => Math.min(4000, Math.ceil(passage.length / 2) + 200);

const cleaned = (answer: string) => {
  const trimmed = answer.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).replace(/^\n+|\s+$/gu, "");
};

const wordsIn = (text: string) => (text.match(/\S+/gu) ?? []).length;

export const plannedRewriteCalls = async (request: RewriteRequest, issues: LintIssue[]): Promise<PlannedCall[]> => {
  const [from, to] = passageBounds(request.text, request.start, request.end);
  const passage = request.text.slice(from, to);
  const within = issues.filter((issue) => issue.start >= from && issue.end <= to);
  return [{ stage: "rewrite", messages: rewriteMessages(await styleGuide(), passage, within, from), maxOutputTokens: outputTokensFor(passage) }];
};

export const rewritePassage = async (ctx: ActionContext, lint: LintService, request: RewriteRequest): Promise<Rewrite> => {
  const [from, to] = passageBounds(request.text, request.start, request.end);
  const passage = request.text.slice(from, to);
  const all = await lint.lint(request.text);
  const before = all.filter((issue) => issue.start >= from && issue.end <= to);
  ctx.progress({ step: "rewriting passage", done: 0, total: 1 });
  const result = await ctx.call("rewrite", {
    messages: rewriteMessages(await styleGuide(), passage, before, from),
    maxOutputTokens: outputTokensFor(passage),
    temperature: 0.3,
  });
  const replacement = cleaned(result.content);
  const after = replacement === "" ? [] : await lint.lint(replacement);
  const was = wordsIn(passage);
  const is = wordsIn(replacement);
  const reason =
    replacement === ""
      ? "the model returned nothing"
      : result.truncated
        ? "the model ran out of room before finishing the passage"
        : was >= 12 && (is < was / 2 || is > was * 2)
          ? `the model returned ${is} words for a passage of ${was}`
          : after.length > before.length
            ? `the rewrite has ${after.length} style issues, more than the ${before.length} it started with`
            : undefined;
  ctx.progress({ step: "rewrite ready", done: 1, total: 1 });
  return { start: from, end: to, original: passage, replacement, before, after, accepted: reason === undefined, reason };
};
