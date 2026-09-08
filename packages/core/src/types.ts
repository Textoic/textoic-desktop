export type ProviderKind = "ollama" | "openrouter";

export type ResearchEffort = "low" | "medium" | "high";

export interface ModelPricing {
  prompt: number;
  completion: number;
}

export interface Settings {
  provider: ProviderKind;
  model: string;
  ollamaUrl: string;
  ollamaContextTokens: number;
  openrouterKey: string;
  searxngUrl: string;
  serperKey: string;
  lintIdleMs: number;
  lintRules: Record<string, boolean>;
  pricingOverrides: Record<string, ModelPricing>;
  contextBudgetTokens: number;
  auditCoalesceMs: number;
  research: { budgetUsd: number; effort: ResearchEffort };
}

export type TemplateKind = "blank" | "tweet" | "article" | "novel";

export interface TweetSettings {
  prompt: string;
}

export interface ArticleSettings {
  prompt: string;
  minWords: number;
  maxWords: number;
}

export interface NovelSettings {
  prompt: string;
  wordCount: number;
  genre: string;
  nsfw: boolean;
  stylePrompt?: string;
}

export type TemplateSettings = TweetSettings | ArticleSettings | NovelSettings;

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  template: TemplateKind;
  templateSettings?: TemplateSettings;
  documentIds: string[];
  activeDocumentId: string | null;
  contextItemIds: string[];
  novel?: NovelState;
}

export type DocumentKind = "markdown" | "text";

export interface Document {
  id: string;
  sessionId: string;
  title: string;
  kind: DocumentKind;
  content: string;
  contentHash: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ContextKind =
  | "text"
  | "markdown"
  | "code"
  | "data"
  | "research"
  | "document";

export type ContextSource =
  | { type: "upload"; fileName: string }
  | { type: "folder"; root: string; path: string }
  | { type: "session"; sessionId: string; documentId?: string }
  | { type: "research"; runId: string; topic: string }
  | { type: "paste" };

export interface ContextChunk {
  id: string;
  at: number;
  end: number;
  tokens: number;
  heading?: string;
}

export interface Digest {
  model: string;
  text: string;
  tokens: number;
  createdAt: string;
}

export interface ContextItem {
  id: string;
  name: string;
  kind: ContextKind;
  bytes: number;
  words: number;
  tokens: number;
  createdAt: string;
  source: ContextSource;
  chunks: ContextChunk[];
  digests: Record<string, Digest>;
  outline?: string[];
  collectionId?: string;
}

export interface ContextCollection {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  itemIds: string[];
  skipped: { path: string; reason: string }[];
  tokens: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export interface CostLine {
  stage: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface CostEstimate {
  provider: ProviderKind;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  known: boolean;
  breakdown: CostLine[];
  note?: string;
}

export interface AiCall {
  stage: string;
  provider: ProviderKind;
  model: string;
  messages: ChatMessage[];
  params: { temperature?: number; maxOutputTokens?: number; json?: boolean };
  usage: TokenUsage;
  costUsd: number;
  durationMs: number;
  finishReason?: string;
  output: string;
}

export interface AiTrace {
  estimate?: CostEstimate;
  calls: AiCall[];
  totalUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  params?: Record<string, unknown>;
}

export type Actor =
  | { kind: "human" }
  | { kind: "ai"; provider: ProviderKind; model: string }
  | { kind: "system" };

export type AuditTargetType =
  | "document"
  | "blueprint"
  | "context"
  | "session"
  | "factcheck"
  | "research"
  | "settings";

export interface AuditEntry {
  id: string;
  sessionId: string;
  at: string;
  actor: Actor;
  action: string;
  summary: string;
  target?: { type: AuditTargetType; id: string; title?: string };
  before?: string;
  after?: string;
  diff?: string;
  ai?: AiTrace;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderKind;
  contextLength?: number;
  pricing?: ModelPricing;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobProgress {
  step: string;
  done: number;
  total: number;
  message?: string;
}

export interface Job {
  id: string;
  sessionId?: string;
  action: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: JobProgress;
  estimate?: CostEstimate;
  spentUsd: number;
  result?: unknown;
  error?: string;
  auditEntryId?: string;
}

export interface LintSuggestion {
  range: [number, number];
  text: string;
}

export interface LintIssue {
  id: string;
  start: number;
  end: number;
  message: string;
  suggestions?: LintSuggestion[];
}

export interface Rewrite {
  start: number;
  end: number;
  original: string;
  replacement: string;
  before: LintIssue[];
  after: LintIssue[];
  accepted: boolean;
  reason?: string;
}

export type Verdict = "supported" | "contradicted" | "unverifiable";

export interface Evidence {
  itemId: string;
  itemName: string;
  chunkId: string;
  excerpt: string;
}

export interface FactFinding {
  id: string;
  claim: string;
  quote: string;
  start: number;
  end: number;
  verdict: Verdict;
  confidence: number;
  explanation: string;
  evidence: Evidence[];
}

export interface FactCheckRun {
  id: string;
  sessionId: string;
  documentId: string;
  documentHash: string;
  at: string;
  model: string;
  claims: number;
  findings: FactFinding[];
  contextItemIds: string[];
  spentUsd: number;
}

export interface ResearchRecord {
  id: string;
  sessionId: string;
  topic: string;
  effort: ResearchEffort;
  budgetUsd: number;
  spentUsd: number;
  stopReason: string;
  at: string;
  contextItemId: string;
  sources: number;
  limitations: string[];
  model: string;
  provider: ProviderKind;
}

export interface CoreStoryElements {
  tone: string;
  genres: string[];
  structure: string;
  keyStages: string[];
  coreTheme: string;
  emotionalJourney: string;
  initialSynopsis: string;
  worldRules: string[];
}

export interface ProtagonistProfile {
  name: string;
  age: string;
  physicalDescription: string;
  traits: string[];
  flaw: string;
  desires: string[];
  fears: string[];
  background: string;
  arc: string;
}

export interface SecondaryCharacter {
  id: string;
  name: string;
  role: string;
  relationship: string;
  physicalDescription: string;
  motivation: string;
  conflict: string;
  arc: string;
}

export interface WorldSettings {
  primaryLocations: string[];
  timeframe: string;
  atmosphere: string;
  naturalLaws: string[];
  supernaturalElements: string[];
  consequences: string[];
  powerStructures: string;
  conflicts: string;
  symbols: string[];
}

export interface PlotPoint {
  id: string;
  name: string;
  description: string;
  wordCountLocation: number;
  characterImpact: string;
}

export interface NovelFramework {
  title: string;
  hook: string;
  ignitionPoint: string;
  plotPoints: PlotPoint[];
  climax: string;
  resolution: string;
  characterTransformation: string;
}

export interface NovelPartPlan {
  number: number;
  title: string;
  synopsis: string;
  wordCount: number;
}

export interface ChapterPlan {
  number: number;
  title: string;
  synopsis: string;
  wordCount: number;
  nsfw: boolean;
}

export interface PartOutline {
  partNumber: number;
  chapters: ChapterPlan[];
}

export interface SceneOutline {
  number: number;
  wordCount: number;
  synopsis: string;
  nsfw: boolean;
}

export interface ChapterOutline {
  partNumber: number;
  chapterNumber: number;
  scenes: SceneOutline[];
}

export interface NovelBlueprint {
  coreElements?: CoreStoryElements;
  protagonist?: ProtagonistProfile;
  characters?: SecondaryCharacter[];
  world?: WorldSettings;
  framework?: NovelFramework;
  parts?: NovelPartPlan[];
  partOutlines?: PartOutline[];
}

export type BlueprintStep =
  | "coreElements"
  | "protagonist"
  | "characters"
  | "world"
  | "framework"
  | "parts"
  | "partOutlines";

export const BLUEPRINT_STEPS: BlueprintStep[] = [
  "coreElements",
  "protagonist",
  "characters",
  "world",
  "framework",
  "parts",
  "partOutlines",
];

export interface NovelState {
  settings: NovelSettings;
  blueprint: NovelBlueprint;
  approved: boolean;
  updatedAt: string;
  testChapter?: {
    documentId: string;
    outline: ChapterOutline;
    at: string;
  };
}
