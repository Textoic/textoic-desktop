import type { ActionContext } from "../actions/context.js";
import type { Storage } from "../storage/storage.js";
import type { ChatMessage, ContextItem } from "../types.js";
import { estimateTokens, sha256, truncate } from "../util.js";
import type { ContextService } from "./store.js";

export interface ExploreOptions {
  sessionId: string;
  task: string;
  maxSteps?: number;
  readTokens?: number;
}

export interface Brief {
  text: string;
  cached: boolean;
  steps: number;
  key: string;
}

type Step =
  | { action: "list" }
  | { action: "search"; query: string }
  | { action: "read"; itemId: string; chunkId?: string }
  | { action: "finish"; brief: string };

const STEP_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string" },
    action: { type: "string", enum: ["list", "search", "read", "finish"] },
    query: { type: "string" },
    itemId: { type: "string" },
    chunkId: { type: "string" },
    brief: { type: "string" },
  },
  required: ["action"],
};

const DEFAULT_STEPS = 12;
const DEFAULT_READ_TOKENS = 1200;
const OBSERVATION_KEPT = 6000;

const system = `You are a research assistant with read access to a corpus of documents attached to a writing session. You cannot read everything: work like an engineer exploring an unfamiliar codebase. List what exists, search for the terms that matter, read only the passages you need, and stop as soon as you can write the brief.

Each turn, reply with one JSON object: {"thought": "...", "action": "list" | "search" | "read" | "finish", "query": "...", "itemId": "...", "chunkId": "...", "brief": "..."}.
- "list" shows every document with its size, outline and chunk ids.
- "search" runs a keyword search over all chunks; give a short "query".
- "read" returns one chunk: give "itemId" and "chunkId" (from list or search).
- "finish" ends with "brief": the condensed context the writer needs for the task, under 500 words, with the document names the facts came from in brackets.

Never invent facts. If the corpus does not cover something, say so in the brief.`;

const listing = (items: ContextItem[]) =>
  items
    .map(
      (item) =>
        `- ${item.id.slice(0, 12)} ${item.name} (${item.kind}, ${item.words} words, chunks ${item.chunks[0]?.id ?? "-"}..${item.chunks[item.chunks.length - 1]?.id ?? "-"})${
          item.outline?.length ? `\n  outline: ${truncate(item.outline.join(" | "), 400)}` : ""
        }`,
    )
    .join("\n");

const validate = (value: unknown): Step => {
  const step = value as Record<string, unknown>;
  const action = step?.action;
  if (action === "list") {
    return { action };
  }

  if (action === "search" && typeof step.query === "string") {
    return { action, query: step.query };
  }

  if (action === "read" && typeof step.itemId === "string") {
    return { action, itemId: step.itemId, chunkId: typeof step.chunkId === "string" ? step.chunkId : undefined };
  }

  if (action === "finish" && typeof step.brief === "string") {
    return { action, brief: step.brief };
  }

  throw new Error("The explorer answered with an action it cannot take.");
};

export const briefKey = (task: string, manifest: string, model: string) =>
  sha256(`brief\n${model}\n${manifest}\n${task}`);

export const cachedBrief = async (
  storage: Storage,
  context: ContextService,
  options: ExploreOptions,
  model: string,
): Promise<Brief | null> => {
  const key = briefKey(options.task, await context.manifest(options.sessionId), model);
  const text = await storage.blobs.get(key);
  return text === null ? null : { text, cached: true, steps: 0, key };
};

export const explore = async (
  ctx: ActionContext,
  storage: Storage,
  context: ContextService,
  options: ExploreOptions,
): Promise<Brief> => {
  const cached = await cachedBrief(storage, context, options, ctx.provider.model);
  if (cached) {
    return cached;
  }

  const items = await context.itemsFor(options.sessionId);
  const byPrefix = (prefix: string) =>
    items.find((item) => item.id === prefix || item.id.startsWith(prefix));
  const maxSteps = options.maxSteps ?? DEFAULT_STEPS;
  const readTokens = options.readTokens ?? DEFAULT_READ_TOKENS;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Task the writer needs context for:\n${options.task}\n\nThe corpus has ${items.length} documents (${items.reduce((total, item) => total + item.tokens, 0)} tokens). Start.`,
    },
  ];

  let brief = "";
  let steps = 0;
  while (steps < maxSteps) {
    steps += 1;
    ctx.progress({ step: "exploring context", done: steps, total: maxSteps });
    const step = await ctx.callJson<Step>(`explore:${steps}`, { messages, maxOutputTokens: 1200, temperature: 0.1 }, STEP_SCHEMA, validate);
    messages.push({ role: "assistant", content: JSON.stringify(step) });
    if (step.action === "finish") {
      brief = step.brief.trim();
      break;
    }

    const observation = await observe(context, options.sessionId, items, byPrefix, step, readTokens);
    messages.push({ role: "user", content: truncate(observation, OBSERVATION_KEPT) });
    if (steps === maxSteps - 1) {
      messages.push({ role: "user", content: "You have one step left. Answer with \"finish\" and the brief now." });
    }
  }

  if (brief === "") {
    const wrap = await ctx.call("explore:wrap", {
      messages: [...messages, { role: "user", content: "Write the brief now from what you have read, in plain text under 500 words." }],
      maxOutputTokens: 1200,
      temperature: 0.1,
    });
    brief = wrap.content.trim();
  }

  const key = briefKey(options.task, await context.manifest(options.sessionId), ctx.provider.model);
  await storage.blobs.put(key, brief);
  return { text: brief, cached: false, steps, key };
};

const observe = async (
  context: ContextService,
  sessionId: string,
  items: ContextItem[],
  byPrefix: (prefix: string) => ContextItem | undefined,
  step: Step,
  readTokens: number,
): Promise<string> => {
  if (step.action === "list") {
    return `Documents:\n${listing(items)}`;
  }

  if (step.action === "search") {
    const hits = await context.search(sessionId, step.query, 8);
    return hits.length === 0
      ? `No chunks match "${step.query}".`
      : hits
          .map((hit) => `- ${hit.item.id.slice(0, 12)} ${hit.item.name} [${hit.chunkId}] (score ${hit.score.toFixed(1)}): ${context.excerpt(hit.text, 300)}`)
          .join("\n");
  }

  if (step.action === "read") {
    const item = byPrefix(step.itemId);
    if (!item) {
      return `No document with id ${step.itemId}. Use "list" to see ids.`;
    }

    const chunkId = step.chunkId ?? item.chunks[0]?.id;
    const chunk = item.chunks.find((one) => one.id === chunkId);
    if (!chunk) {
      return `No chunk ${chunkId} in ${item.name}; its chunks run ${item.chunks[0]?.id}..${item.chunks[item.chunks.length - 1]?.id}.`;
    }

    const text = await context.chunk(item, chunk.id);
    const capped = estimateTokens(text) > readTokens ? `${text.slice(0, readTokens * 4)}\n[… truncated]` : text;
    return `${item.name} [${chunk.id}]${chunk.heading ? ` under "${chunk.heading}"` : ""}:\n${capped}`;
  }

  return "Done.";
};
