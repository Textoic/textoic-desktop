import { createHash, randomUUID } from "node:crypto";

export const now = () => new Date().toISOString();

export const id = () => randomUUID();

export const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

export const shortHash = (text: string) => sha256(text).slice(0, 16);

export const countWords = (text: string) =>
  (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export const estimateMessageTokens = (
  messages: { content: string }[],
): number =>
  messages.reduce(
    (total, message) => total + estimateTokens(message.content) + 4,
    3,
  );

export const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

export const truncate = (text: string, most: number) =>
  text.length <= most ? text : `${text.slice(0, most - 1)}…`;

export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60) || "untitled";

export const titleFromText = (text: string, fallback = "Untitled") => {
  const heading = /^\s*#+\s+(.+)$/mu.exec(text);
  if (heading) {
    return heading[1].trim().slice(0, 80);
  }

  const line = text
    .split("\n")
    .map((one) => one.trim())
    .find((one) => one !== "");
  return line ? line.replace(/[*_`#>]/gu, "").slice(0, 80) : fallback;
};

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

export class TextoicError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TextoicError";
    this.status = status;
  }
}
