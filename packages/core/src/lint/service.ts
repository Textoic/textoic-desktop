import { ErrorId, defaults } from "english-lint";
import type { Config } from "english-lint/types";
import type { LintIssue, Settings } from "../types.js";
import { DocumentLinter, lintOnce, type LintRun } from "./incremental.js";
import { loadParser, type Parser } from "./parser.js";

export const ruleIds = Object.values(ErrorId) as string[];

export const ruleDefaults = (): Record<string, boolean> =>
  Object.fromEntries(ruleIds.map((rule) => [rule, defaults[rule as ErrorId] === true]));

export const configFrom = (rules: Record<string, boolean>): Config => ({
  ...defaults,
  ...Object.fromEntries(
    Object.entries(rules).filter(([rule]) => ruleIds.includes(rule)),
  ),
});

export class LintService {
  private readonly settings: () => Promise<Settings>;
  private readonly linters = new Map<string, DocumentLinter>();
  private parser: Parser | null = null;

  constructor(settings: () => Promise<Settings>) {
    this.settings = settings;
  }

  async ready(): Promise<Parser> {
    this.parser ??= await loadParser();
    return this.parser;
  }

  async config(): Promise<Config> {
    return configFrom((await this.settings()).lintRules);
  }

  async lint(text: string): Promise<LintIssue[]> {
    const parser = await this.ready();
    return lintOnce(parser, text, await this.config());
  }

  async linterFor(key: string): Promise<DocumentLinter> {
    const parser = await this.ready();
    const config = await this.config();
    const existing = this.linters.get(key);
    if (existing) {
      existing.configure(config);
      return existing;
    }

    const linter = new DocumentLinter(parser, config);
    this.linters.set(key, linter);
    return linter;
  }

  async lintIncremental(key: string, text: string): Promise<LintRun> {
    const linter = await this.linterFor(key);
    return linter.lint(text);
  }

  release(key: string) {
    this.linters.delete(key);
  }
}
