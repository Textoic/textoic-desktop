import type { ActionContext } from "../actions/context.js";
import type { PlannedCall } from "../cost.js";
import type { ChatMessage } from "../types.js";
import { countWords } from "../util.js";

export const ARTICLE_MIN_WORDS = 500;
export const ARTICLE_MAX_WORDS = 1000;

const PLAN_TOKENS = 900;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    angle: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          points: { type: "array", items: { type: "string" } },
          words: { type: "number" },
        },
        required: ["heading", "points", "words"],
      },
    },
  },
  required: ["title", "sections"],
};

interface Plan {
  title: string;
  angle?: string;
  sections: { heading: string; points: string[]; words: number }[];
}

const validatePlan = (value: unknown): Plan => {
  const plan = value as Plan;
  if (!plan || typeof plan.title !== "string" || !Array.isArray(plan.sections) || plan.sections.length === 0) {
    throw new Error("The plan needs a title and at least one section.");
  }

  return plan;
};

const writerSystem = `You are a writer producing a finished article in Markdown. Write in the active voice, one idea per sentence, concrete words over abstract ones, no filler, no hedging, no bullet lists unless the material is a genuine list, no closing summary paragraph. Do not announce what you are about to say. Return only the article.`;

export const planMessages = (prompt: string, min: number, max: number, context: string): ChatMessage[] => [
  {
    role: "system",
    content: "You plan articles. Answer in JSON only.",
  },
  {
    role: "user",
    content: `${context ? `${context}\n\n` : ""}Plan an article of ${min}-${max} words about:\n${prompt.trim()}\n\nReply with JSON: {"title": string, "angle": one sentence on the thesis, "sections": [{"heading": string, "points": [2-4 concrete points], "words": target word count}]}. Use 3-6 sections whose word targets add up to about ${Math.round((min + max) / 2)} words. Headings must be specific, not generic labels like Introduction or Conclusion.`,
  },
];

export const draftMessages = (prompt: string, plan: Plan, min: number, max: number, context: string): ChatMessage[] => [
  { role: "system", content: writerSystem },
  {
    role: "user",
    content: `${context ? `${context}\n\n` : ""}Write the article described by this plan, between ${min} and ${max} words in total. Use the title as a level-1 heading and the section headings as level-2 headings.

Brief from the writer:
${prompt.trim()}

Plan:
${JSON.stringify(plan, null, 2)}

Return only the Markdown article.`,
  },
];

export const plannedArticleCalls = (prompt: string, min: number, max: number, context: string): PlannedCall[] => {
  const plan: Plan = { title: "", sections: Array.from({ length: 4 }, () => ({ heading: "", points: ["", "", ""], words: 0 })) };
  return [
    { stage: "article:plan", messages: planMessages(prompt, min, max, context), maxOutputTokens: PLAN_TOKENS },
    { stage: "article:draft", messages: draftMessages(prompt, plan, min, max, context), maxOutputTokens: Math.ceil(max * 1.6) + 200 },
  ];
};

export const generateArticle = async (
  ctx: ActionContext,
  prompt: string,
  min: number,
  max: number,
  context: string,
): Promise<{ title: string; markdown: string; words: number }> => {
  ctx.progress({ step: "planning article", done: 0, total: 3 });
  const plan = await ctx.callJson("article:plan", { messages: planMessages(prompt, min, max, context), maxOutputTokens: PLAN_TOKENS, temperature: 0.6 }, PLAN_SCHEMA, validatePlan);

  ctx.progress({ step: "drafting article", done: 1, total: 3 });
  const messages = draftMessages(prompt, plan, min, max, context);
  const maxOutputTokens = Math.ceil(max * 1.6) + 200;
  let markdown = (await ctx.call("article:draft", { messages, maxOutputTokens, temperature: 0.7 })).content.trim();
  let words = countWords(markdown);
  if (words < min * 0.9 || words > max * 1.1) {
    ctx.progress({ step: words < min ? "expanding article" : "trimming article", done: 2, total: 3 });
    const revised = await ctx.call("article:resize", {
      messages: [
        ...messages,
        { role: "assistant", content: markdown },
        {
          role: "user",
          content: `That draft is ${words} words. It must be between ${min} and ${max} words. ${
            words < min ? "Develop the points further with concrete detail" : "Cut the weakest material"
          } and return the full revised article in Markdown, nothing else.`,
        },
      ],
      maxOutputTokens,
      temperature: 0.5,
    });
    if (revised.content.trim() !== "") {
      markdown = revised.content.trim();
      words = countWords(markdown);
    }
  }

  ctx.progress({ step: "article written", done: 3, total: 3 });
  return { title: plan.title, markdown, words };
};
