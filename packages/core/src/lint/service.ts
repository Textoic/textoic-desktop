import { ruleCatalog } from "@textoic/enlint/catalog";
import {
  lintText,
  resolveConfig,
  toEnlintConfig,
  type Parser,
  type ResolvedConfig,
} from "@textoic/enlint-lsp";
import { loadParser } from "@textoic/enlint-lsp/node";
import type { LintError } from "@textoic/enlint/types";
import type { LintIssue, Settings } from "../types.js";

export const ruleIds = ruleCatalog.map(({ id }) => id as string);

export const ruleDefaults = (): Record<string, boolean> =>
  Object.fromEntries(ruleCatalog.map(({ id, enabledByDefault }) => [id, enabledByDefault]));

export const toIssues = (problems: LintError[]): LintIssue[] =>
  problems.map(({ id, start, end, message, suggestions, case: key }) => ({
    id,
    start,
    end,
    message,
    ...(suggestions ? { suggestions } : {}),
    ...(key === undefined ? {} : { case: key }),
  }));

let sharedParser: Promise<Parser> | null = null;

export const parser = (): Promise<Parser> => {
  sharedParser ??= loadParser();
  return sharedParser;
};

export class LintService {
  private readonly settings: () => Promise<Settings>;

  constructor(settings: () => Promise<Settings>) {
    this.settings = settings;
  }

  ready(): Promise<Parser> {
    return parser();
  }

  async config(): Promise<ResolvedConfig> {
    return resolveConfig((await this.settings()).lint);
  }

  async lint(text: string): Promise<LintIssue[]> {
    const [parse, config] = await Promise.all([this.ready(), this.config()]);
    return toIssues(lintText(parse, text, toEnlintConfig(config)));
  }
}
