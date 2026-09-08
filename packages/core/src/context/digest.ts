import type { ActionContext } from "../actions/context.js";
import type { ContextItem } from "../types.js";
import { estimateTokens, now, truncate } from "../util.js";
import type { ContextService } from "./store.js";

const SAMPLE_CHARS = 24_000;
const DIGEST_OUTPUT_TOKENS = 400;

export const digestSample = (item: ContextItem, text: string): string => {
  if (text.length <= SAMPLE_CHARS) {
    return text;
  }

  const head = text.slice(0, SAMPLE_CHARS * 0.6);
  const tail = text.slice(-SAMPLE_CHARS * 0.25);
  const outline = (item.outline ?? []).join("\n");
  return `${head}\n\n[… ${item.words} words in total; outline of the whole file:\n${truncate(outline, 3000)} …]\n\n${tail}`;
};

export const digestMessages = (item: ContextItem, sample: string) => [
  {
    role: "system" as const,
    content:
      "You write compact reference cards for documents so a writer can decide what to read. Answer in plain text, at most 120 words: one sentence saying what the document is, then the key facts, names, numbers and claims a writer would need. No preamble.",
  },
  {
    role: "user" as const,
    content: `Document "${item.name}" (${item.kind}, ${item.words} words):\n\n${sample}`,
  },
];

export const plannedDigestCalls = async (
  context: ContextService,
  items: ContextItem[],
  model: string,
) => {
  const planned = [];
  for (const item of items) {
    if (item.digests[model]) {
      continue;
    }

    const sample = digestSample(item, await context.text(item.id));
    planned.push({
      stage: `digest:${item.name}`,
      messages: digestMessages(item, sample),
      maxOutputTokens: DIGEST_OUTPUT_TOKENS,
    });
  }

  return planned;
};

export const digestItem = async (
  ctx: ActionContext,
  context: ContextService,
  item: ContextItem,
): Promise<ContextItem> => {
  const model = ctx.provider.model;
  if (item.digests[model]) {
    return item;
  }

  const sample = digestSample(item, await context.text(item.id));
  const result = await ctx.call(`digest:${item.name}`, {
    messages: digestMessages(item, sample),
    maxOutputTokens: DIGEST_OUTPUT_TOKENS,
    temperature: 0.1,
  });
  const text = result.content.trim();
  const updated: ContextItem = {
    ...item,
    digests: {
      ...item.digests,
      [model]: { model, text, tokens: estimateTokens(text), createdAt: now() },
    },
  };
  await context.put(updated);
  return updated;
};
