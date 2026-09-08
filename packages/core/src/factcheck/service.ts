import type { ActionContext } from "../actions/context.js";
import type { ContextService } from "../context/store.js";
import type { PlannedCall } from "../cost.js";
import type { Storage } from "../storage/storage.js";
import type { ChatMessage, Document, Evidence, FactCheckRun, FactFinding, Verdict } from "../types.js";
import { countWords, estimateTokens, id, now, sha256 } from "../util.js";

const WINDOW_CHARS = 6000;
const CLAIMS_PER_JUDGE = 6;
const EVIDENCE_PER_CLAIM = 4;
const EVIDENCE_CHARS = 700;
const EXTRACT_TOKENS = 1500;
const JUDGE_TOKENS = 1800;

interface Claim {
  id: string;
  claim: string;
  quote: string;
  start: number;
  end: number;
}

const CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: { type: "string" }, quote: { type: "string" } },
        required: ["claim", "quote"],
      },
    },
  },
  required: ["claims"],
};

const VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["supported", "contradicted", "unverifiable"] },
          confidence: { type: "number" },
          explanation: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["id", "verdict", "explanation"],
      },
    },
  },
  required: ["verdicts"],
};

const extractMessages = (text: string): ChatMessage[] => [
  {
    role: "system",
    content:
      "You extract checkable factual claims from a passage: statements about the world that could be true or false (dates, numbers, events, attributions, causal claims, descriptions of real things). Skip opinions, rhetorical questions, instructions and fiction framed as fiction. Answer in JSON only.",
  },
  {
    role: "user",
    content: `Passage:\n${text}\n\nReply with JSON {"claims": [{"claim": the claim in your own words, "quote": the exact sentence or fragment copied verbatim from the passage that makes the claim}]}. At most 12 claims, most important first. The quote must be copied exactly, character for character.`,
  },
];

const judgeMessages = (batch: { claim: Claim; evidence: Evidence[] }[]): ChatMessage[] => [
  {
    role: "system",
    content:
      "You are a fact-checker. For each claim you get evidence excerpts retrieved from the writer's reference material. Judge each claim only against that evidence: 'supported' when the evidence backs it, 'contradicted' when the evidence conflicts with it, 'unverifiable' when the evidence does not settle it. Never rely on your own memory as evidence. Answer in JSON only.",
  },
  {
    role: "user",
    content: `${batch
      .map(
        ({ claim, evidence }) =>
          `Claim ${claim.id}: ${claim.claim}\nQuoted text: "${claim.quote}"\nEvidence:\n${
            evidence.length === 0
              ? "(no relevant excerpts found)"
              : evidence.map((one) => `[${one.chunkId}] from ${one.itemName}: ${one.excerpt}`).join("\n")
          }`,
      )
      .join("\n\n")}\n\nReply with JSON {"verdicts": [{"id": claim id, "verdict": "supported"|"contradicted"|"unverifiable", "confidence": 0-1, "explanation": one or two sentences, "evidence": [chunk ids you relied on]}]}.`,
  },
];

const windows = (text: string): { at: number; text: string }[] => {
  const made: { at: number; text: string }[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + WINDOW_CHARS);
    if (end < text.length) {
      const cut = text.lastIndexOf("\n\n", end);
      if (cut > at + WINDOW_CHARS / 2) {
        end = cut;
      }
    }

    made.push({ at, text: text.slice(at, end) });
    at = end;
  }

  return made;
};

const normalize = (text: string) => text.replace(/\s+/gu, " ").replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'").trim();

export const locateQuote = (text: string, quote: string, from = 0): [number, number] | null => {
  const direct = text.indexOf(quote, from);
  if (direct !== -1) {
    return [direct, direct + quote.length];
  }

  const wanted = normalize(quote);
  if (wanted.length < 12) {
    return null;
  }

  const head = wanted.slice(0, 40);
  const pattern = new RegExp(head.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+").replace(/["']/gu, "[\"'“”‘’]"), "u");
  const match = pattern.exec(text.slice(from));
  if (!match) {
    return null;
  }

  const start = from + match.index;
  const end = Math.min(text.length, start + Math.round(quote.length * 1.15));
  return [start, end];
};

export const plannedFactCheckCalls = (document: Document): PlannedCall[] => {
  const parts = windows(document.content);
  const claims = Math.max(1, Math.round(countWords(document.content) / 60));
  const judges = Math.ceil(claims / CLAIMS_PER_JUDGE);
  return [
    ...parts.map((part, index) => ({ stage: `extract claims ${index + 1}`, messages: extractMessages(part.text), maxOutputTokens: EXTRACT_TOKENS })),
    ...Array.from({ length: judges }, (_, index) => ({
      stage: `judge batch ${index + 1}`,
      inputTokens: estimateTokens("x".repeat(CLAIMS_PER_JUDGE * (EVIDENCE_PER_CLAIM * EVIDENCE_CHARS + 300))) + 300,
      maxOutputTokens: JUDGE_TOKENS,
    })),
  ];
};

export class FactCheckService {
  private readonly storage: Storage;
  private readonly context: ContextService;

  constructor(storage: Storage, context: ContextService) {
    this.storage = storage;
    this.context = context;
  }

  list(sessionId: string) {
    return this.storage.factChecks.list(sessionId);
  }

  get(sessionId: string, runId: string) {
    return this.storage.factChecks.get(sessionId, runId);
  }

  async run(ctx: ActionContext, sessionId: string, document: Document): Promise<FactCheckRun> {
    const claims = await this.extract(ctx, document.content);
    const findings = await this.judge(ctx, sessionId, claims);
    ctx.progress({ step: `${claims.length} claim${claims.length === 1 ? "" : "s"} checked`, done: 1, total: 1 });
    const items = await this.context.itemsFor(sessionId);
    const run: FactCheckRun = {
      id: id(),
      sessionId,
      documentId: document.id,
      documentHash: sha256(document.content),
      at: now(),
      model: ctx.provider.model,
      claims: claims.length,
      findings,
      contextItemIds: items.map((item) => item.id),
      spentUsd: ctx.trace.totalUsd,
    };
    await this.storage.factChecks.put(run);
    return run;
  }

  private async extract(ctx: ActionContext, text: string): Promise<Claim[]> {
    const parts = windows(text);
    const claims: Claim[] = [];
    for (const [index, part] of parts.entries()) {
      ctx.progress({ step: `extracting claims (${index + 1}/${parts.length})`, done: index, total: parts.length + 1 });
      const found = await ctx.callJson<{ claims: { claim: string; quote: string }[] }>(
        `extract claims ${index + 1}`,
        { messages: extractMessages(part.text), maxOutputTokens: EXTRACT_TOKENS, temperature: 0.1 },
        CLAIMS_SCHEMA,
        (value) => {
          const parsed = value as { claims?: unknown };
          if (!parsed || !Array.isArray(parsed.claims)) {
            throw new Error("claims must be an array");
          }

          return parsed as { claims: { claim: string; quote: string }[] };
        },
      );
      let cursor = part.at;
      for (const candidate of found.claims) {
        if (typeof candidate.quote !== "string" || typeof candidate.claim !== "string") {
          continue;
        }

        const located = locateQuote(text, candidate.quote, cursor) ?? locateQuote(text, candidate.quote, part.at);
        if (!located) {
          continue;
        }

        cursor = located[0];
        claims.push({ id: `k${claims.length + 1}`, claim: candidate.claim, quote: candidate.quote, start: located[0], end: located[1] });
      }
    }

    return claims;
  }

  private async judge(ctx: ActionContext, sessionId: string, claims: Claim[]): Promise<FactFinding[]> {
    const findings: FactFinding[] = [];
    const batches = Math.ceil(claims.length / CLAIMS_PER_JUDGE);
    for (let index = 0; index < batches; index += 1) {
      ctx.progress({ step: `judging claims (${index + 1}/${batches})`, done: index, total: batches });
      const batch = claims.slice(index * CLAIMS_PER_JUDGE, (index + 1) * CLAIMS_PER_JUDGE);
      const withEvidence = await Promise.all(
        batch.map(async (claim) => ({
          claim,
          evidence: (await this.context.search(sessionId, `${claim.claim} ${claim.quote}`, EVIDENCE_PER_CLAIM)).map((hit) => ({
            itemId: hit.item.id,
            itemName: hit.item.name,
            chunkId: `${hit.item.id.slice(0, 8)}:${hit.chunkId}`,
            excerpt: this.context.excerpt(hit.text, EVIDENCE_CHARS),
          })),
        })),
      );
      const judged = await ctx.callJson<{ verdicts: { id: string; verdict: Verdict; confidence?: number; explanation: string; evidence?: string[] }[] }>(
        `judge batch ${index + 1}`,
        { messages: judgeMessages(withEvidence), maxOutputTokens: JUDGE_TOKENS, temperature: 0.1 },
        VERDICTS_SCHEMA,
      );
      for (const { claim, evidence } of withEvidence) {
        const verdict = judged.verdicts?.find((one) => one.id === claim.id);
        const cited = new Set(verdict?.evidence ?? []);
        findings.push({
          id: claim.id,
          claim: claim.claim,
          quote: claim.quote,
          start: claim.start,
          end: claim.end,
          verdict: verdict && ["supported", "contradicted", "unverifiable"].includes(verdict.verdict) ? verdict.verdict : "unverifiable",
          confidence: typeof verdict?.confidence === "number" ? Math.max(0, Math.min(1, verdict.confidence)) : 0.5,
          explanation: verdict?.explanation ?? "The model returned no verdict for this claim.",
          evidence: evidence.filter((one) => cited.size === 0 || cited.has(one.chunkId)),
        });
      }
    }

    return findings;
  }
}
