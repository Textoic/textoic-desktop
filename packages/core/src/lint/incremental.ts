import lint, { defaults } from "english-lint";
import type { Config, LintError, ParsedToken } from "english-lint/types";
import type { LintIssue } from "../types.js";
import { blocks } from "./markdown.js";
import type { Parser } from "./parser.js";

type Parsed = ParsedToken[][];

const shifted = (sentences: Parsed, by: number): Parsed =>
  sentences.map((tokens) =>
    tokens.map((token) => ({
      ...token,
      misc: { ...token.misc, at: token.misc.at + by },
    })),
  );

export const toIssues = (errors: LintError[]): LintIssue[] =>
  errors.map(({ id, start, end, message, suggestions }) => ({
    id,
    start,
    end,
    message,
    ...(suggestions ? { suggestions } : {}),
  }));

export interface LintRun {
  issues: LintIssue[];
  parsedBlocks: number;
  reusedBlocks: number;
  totalBlocks: number;
}

export class DocumentLinter {
  private readonly parser: Parser;
  private config: Config;
  private cache = new Map<string, Parsed>();

  constructor(parser: Parser, config: Config = defaults) {
    this.parser = parser;
    this.config = config;
  }

  configure(config: Config) {
    this.config = config;
  }

  lint(text: string): LintRun {
    const next = new Map<string, Parsed>();
    let parsed = 0;
    let reused = 0;
    const sentences = blocks(text).flatMap((block) => {
      const cached = this.cache.get(block.text) ?? next.get(block.text);
      if (cached) {
        reused += 1;
        next.set(block.text, cached);
        return shifted(cached, block.at);
      }

      parsed += 1;
      const fresh = this.parser(block.text) as unknown as Parsed;
      next.set(block.text, fresh);
      return shifted(fresh, block.at);
    });
    this.cache = next;
    return {
      issues: toIssues(lint(sentences, this.config)),
      parsedBlocks: parsed,
      reusedBlocks: reused,
      totalBlocks: parsed + reused,
    };
  }
}

export const parseDocument = (parser: Parser, text: string): Parsed =>
  blocks(text).flatMap((block) =>
    shifted(parser(block.text) as unknown as Parsed, block.at),
  );

export const lintOnce = (
  parser: Parser,
  text: string,
  config: Config = defaults,
): LintIssue[] => toIssues(lint(parseDocument(parser, text), config));
