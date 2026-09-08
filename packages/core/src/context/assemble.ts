import type { ContextItem } from "../types.js";
import { estimateTokens } from "../util.js";
import type { ContextService } from "./store.js";

export interface AssembledItem {
  itemId: string;
  name: string;
  mode: "full" | "digest" | "card" | "chunks";
  chunkIds: string[];
  tokens: number;
}

export interface Assembled {
  text: string;
  tokens: number;
  used: AssembledItem[];
  totalItems: number;
  totalTokens: number;
}

export interface AssembleOptions {
  sessionId: string;
  query: string;
  budgetTokens: number;
  model: string;
  brief?: string;
  excludeItemIds?: string[];
  retrievalLimit?: number;
}

const SMALL_ITEM_TOKENS = 900;
const CARD_OUTLINE_LINES = 12;

const fence = (title: string, body: string) =>
  `<<< ${title}\n${body.trim()}\n>>>`;

const card = (item: ContextItem, model: string): string => {
  const digest = item.digests[model]?.text;
  const outline = (item.outline ?? []).slice(0, CARD_OUTLINE_LINES);
  const lines = [
    `${item.name} — ${item.kind}, ${item.words} words`,
    digest ? `Summary: ${digest}` : "",
    outline.length > 0 ? `Outline: ${outline.join(" | ")}` : "",
  ].filter((line) => line !== "");
  return lines.join("\n");
};

const byPriority = (one: ContextItem, other: ContextItem) => {
  const rank = (item: ContextItem) => (item.kind === "research" ? 0 : item.kind === "document" ? 1 : 2);
  return rank(one) - rank(other) || one.tokens - other.tokens;
};

export const assembleContext = async (
  context: ContextService,
  options: AssembleOptions,
): Promise<Assembled> => {
  const excluded = new Set(options.excludeItemIds ?? []);
  const items = (await context.itemsFor(options.sessionId))
    .filter((item) => !excluded.has(item.id))
    .sort(byPriority);
  const totalTokens = items.reduce((total, item) => total + item.tokens, 0);
  const used: AssembledItem[] = [];
  const sections: string[] = [];
  let spent = 0;

  if (options.brief) {
    const tokens = estimateTokens(options.brief);
    sections.push(fence("Brief compiled from the session context", options.brief));
    spent += tokens;
  }

  const remaining = () => options.budgetTokens - spent;

  if (totalTokens <= remaining()) {
    for (const item of items) {
      const text = await context.text(item.id);
      sections.push(fence(`${item.name} (${item.kind})`, text));
      used.push({ itemId: item.id, name: item.name, mode: "full", chunkIds: item.chunks.map((chunk) => chunk.id), tokens: item.tokens });
      spent += item.tokens;
    }

    return { text: sections.join("\n\n"), tokens: spent, used, totalItems: items.length, totalTokens };
  }

  const covered = new Set<string>();
  for (const item of items) {
    if (item.tokens <= SMALL_ITEM_TOKENS && item.tokens <= remaining() * 0.5) {
      const text = await context.text(item.id);
      sections.push(fence(`${item.name} (${item.kind})`, text));
      used.push({ itemId: item.id, name: item.name, mode: "full", chunkIds: item.chunks.map((chunk) => chunk.id), tokens: item.tokens });
      spent += item.tokens;
      covered.add(item.id);
      continue;
    }

    const summary = card(item, options.model);
    const tokens = estimateTokens(summary);
    if (tokens <= remaining() * 0.6) {
      sections.push(fence(`About ${item.name}`, summary));
      used.push({ itemId: item.id, name: item.name, mode: item.digests[options.model] ? "digest" : "card", chunkIds: [], tokens });
      spent += tokens;
    }
  }

  const hits = await context.search(options.sessionId, options.query, options.retrievalLimit ?? 12);
  const perItem = new Map<string, AssembledItem>();
  for (const hit of hits) {
    if (covered.has(hit.item.id) || excluded.has(hit.item.id)) {
      continue;
    }

    const tokens = estimateTokens(hit.text);
    if (tokens > remaining()) {
      continue;
    }

    sections.push(fence(`Excerpt from ${hit.item.name} [${hit.chunkId}]`, hit.text));
    spent += tokens;
    const entry = perItem.get(hit.item.id) ?? {
      itemId: hit.item.id,
      name: hit.item.name,
      mode: "chunks" as const,
      chunkIds: [],
      tokens: 0,
    };
    entry.chunkIds.push(hit.chunkId);
    entry.tokens += tokens;
    perItem.set(hit.item.id, entry);
  }

  used.push(...perItem.values());
  return { text: sections.join("\n\n"), tokens: spent, used, totalItems: items.length, totalTokens };
};

export const contextPreamble = (assembled: Assembled): string =>
  assembled.text === ""
    ? ""
    : `Reference material the writer attached to this session. Use it for facts, names and terminology; do not copy it verbatim unless quoting.\n\n${assembled.text}`;
