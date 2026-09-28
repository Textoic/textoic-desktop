import type { Settings, TextoicConfig } from "./types.js";

export const defaultSettings = (): Settings => ({
  provider: "ollama",
  model: "",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaContextTokens: 32768,
  openrouterKey: "",
  searxngUrl: "http://127.0.0.1:8080",
  serperKey: "",
  lintIdleMs: 750,
  lint: {},
  pricingOverrides: {},
  contextBudgetTokens: 12000,
  auditCoalesceMs: 120000,
  research: { budgetUsd: 0, effort: "medium" },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringOr = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

const fromLegacyRules = (rules: Record<string, unknown>): TextoicConfig => ({
  rules: Object.fromEntries(
    Object.entries(rules)
      .filter(([, on]) => typeof on === "boolean")
      .map(([rule, on]) => [rule, on ? "warn" : "off"]),
  ),
});

const lintConfigOf = (source: Record<string, unknown>, base: TextoicConfig): TextoicConfig =>
  isRecord(source.lint)
    ? (source.lint as TextoicConfig)
    : isRecord(source.lintRules)
      ? fromLegacyRules(source.lintRules)
      : base;

export const mergeSettings = (
  base: Settings,
  patch: Partial<Settings> | Record<string, unknown>,
): Settings => {
  const source = isRecord(patch) ? patch : {};
  const provider = source.provider === "openrouter" ? "openrouter" : source.provider === "ollama" ? "ollama" : base.provider;
  const research = isRecord(source.research) ? source.research : {};
  const effort = research.effort;
  return {
    provider,
    model: stringOr(source.model, base.model),
    ollamaUrl: stringOr(source.ollamaUrl, base.ollamaUrl).replace(/\/+$/u, ""),
    ollamaContextTokens: Math.max(
      2048,
      Math.round(numberOr(source.ollamaContextTokens, base.ollamaContextTokens)),
    ),
    openrouterKey: stringOr(source.openrouterKey, base.openrouterKey),
    searxngUrl: stringOr(source.searxngUrl, base.searxngUrl).replace(/\/+$/u, ""),
    serperKey: stringOr(source.serperKey, base.serperKey),
    lintIdleMs: Math.max(250, Math.round(numberOr(source.lintIdleMs, base.lintIdleMs))),
    lint: lintConfigOf(source, base.lint),
    pricingOverrides: isRecord(source.pricingOverrides)
      ? Object.fromEntries(
          Object.entries(source.pricingOverrides).flatMap(([key, value]) =>
            isRecord(value) &&
            typeof value.prompt === "number" &&
            typeof value.completion === "number"
              ? [[key, { prompt: value.prompt, completion: value.completion }]]
              : [],
          ),
        )
      : base.pricingOverrides,
    contextBudgetTokens: Math.max(
      1000,
      Math.round(numberOr(source.contextBudgetTokens, base.contextBudgetTokens)),
    ),
    auditCoalesceMs: Math.max(0, Math.round(numberOr(source.auditCoalesceMs, base.auditCoalesceMs))),
    research: {
      budgetUsd: Math.max(0, numberOr(research.budgetUsd, base.research.budgetUsd)),
      effort:
        effort === "low" || effort === "medium" || effort === "high"
          ? effort
          : base.research.effort,
    },
  };
};

export const redactedSettings = (settings: Settings) => ({
  ...settings,
  openrouterKey: settings.openrouterKey ? "•••••" + settings.openrouterKey.slice(-4) : "",
  serperKey: settings.serperKey ? "•••••" + settings.serperKey.slice(-4) : "",
  hasOpenrouterKey: settings.openrouterKey !== "",
  hasSerperKey: settings.serperKey !== "",
});

export const isRedactedKey = (value: unknown) =>
  typeof value === "string" && value.startsWith("•••••");
