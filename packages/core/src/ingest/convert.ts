import { extname } from "node:path";
import type { ContextKind } from "../types.js";
import { TextoicError } from "../util.js";

export interface Converted {
  text: string;
  kind: ContextKind;
}

const CODE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh",
  ".bash", ".ps1", ".sql", ".css", ".scss", ".less", ".vue", ".svelte", ".lua",
  ".r", ".scala", ".dart", ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".zig",
]);

const DATA = new Set([".json", ".jsonl", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml", ".ini", ".env", ".cfg"]);

const MARKDOWN = new Set([".md", ".markdown", ".mdx", ".rst", ".adoc", ".txt", ".text"]);

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const looksBinary = (bytes: Uint8Array) => {
  const sample = bytes.subarray(0, 4096);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }

  return sample.length > 0 && suspicious / sample.length > 0.1;
};

const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/^﻿/u, "")
    .replace(/\r\n?/gu, "\n");

export const kindForName = (fileName: string): ContextKind | null => {
  const extension = extname(fileName).toLowerCase();
  if (CODE.has(extension)) {
    return "code";
  }

  if (DATA.has(extension)) {
    return "data";
  }

  if (extension === ".md" || extension === ".markdown" || extension === ".mdx") {
    return "markdown";
  }

  if (MARKDOWN.has(extension) || extension === "") {
    return "text";
  }

  return null;
};

const htmlToMarkdown = async (html: string): Promise<string> => {
  const { default: TurndownService } = await import("turndown");
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  return service
    .turndown(
      html
        .replace(/<script[\s\S]*?<\/script>/giu, "")
        .replace(/<style[\s\S]*?<\/style>/giu, ""),
    )
    .replace(/\r\n?/gu, "\n");
};

const fromDocx = async (bytes: Uint8Array): Promise<Converted> => {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  return { text: await htmlToMarkdown(result.value), kind: "markdown" };
};

const fromHtml = async (bytes: Uint8Array): Promise<Converted> => ({
  text: await htmlToMarkdown(decode(bytes)),
  kind: "markdown",
});

export const convertUpload = async (
  fileName: string,
  bytes: Uint8Array,
): Promise<Converted> => {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new TextoicError(`${fileName} is larger than 25 MB.`, 413);
  }

  const extension = extname(fileName).toLowerCase();
  if (extension === ".docx") {
    return fromDocx(bytes);
  }

  if (extension === ".html" || extension === ".htm") {
    return fromHtml(bytes);
  }

  if (extension === ".pdf") {
    throw new TextoicError(
      "PDF import is not supported yet. Convert the PDF to text, Markdown or DOCX first.",
      415,
    );
  }

  if (looksBinary(bytes)) {
    throw new TextoicError(`${fileName} looks like a binary file.`, 415);
  }

  const text = decode(bytes);
  return { text, kind: kindForName(fileName) ?? "text" };
};
