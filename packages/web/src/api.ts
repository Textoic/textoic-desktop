import type {
  AuditEntry,
  ContextCollection,
  ContextItem,
  CostEstimate,
  Document,
  FactCheckRun,
  Job,
  LintIssue,
  ModelInfo,
  NovelState,
  ProviderKind,
  ResearchRecord,
  Session,
  Settings,
  TemplateKind,
  TemplateSettings,
} from "@textoic/core/types";

export type RedactedSettings = Settings & { hasOpenrouterKey: boolean; hasSerperKey: boolean };

export interface ContextView extends Omit<ContextItem, "chunks"> {
  chunks: number;
  digest: string | null;
  digestModels: string[];
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error ?? message;
    } catch {
      message = `${response.status} ${response.statusText}`;
    }

    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
};

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  settings: () => request<{ settings: RedactedSettings; rules: string[]; ruleDefaults: Record<string, boolean>; promptMaxChars: number }>("/settings"),
  updateSettings: (patch: Record<string, unknown>) => request<{ settings: RedactedSettings }>("/settings", json(patch, "PUT")),
  models: (provider?: ProviderKind) => request<{ models: ModelInfo[] }>(`/models${provider ? `?provider=${provider}` : ""}`),
  sessions: () => request<{ sessions: Session[] }>("/sessions"),
  createSession: (input: { title?: string; template: TemplateKind; templateSettings?: TemplateSettings; initialContent?: string }) =>
    request<{ session: Session; documents: Document[] }>("/sessions", json(input)),
  session: (id: string) => request<{ session: Session; documents: Document[] }>(`/sessions/${id}`),
  updateSession: (id: string, patch: { title?: string; archived?: boolean; activeDocumentId?: string | null }) => request<{ session: Session }>(`/sessions/${id}`, json(patch, "PATCH")),
  deleteSession: (id: string) => request<{ ok: true }>(`/sessions/${id}`, { method: "DELETE" }),
  createDocument: (sessionId: string, input: { title?: string; content?: string; kind?: "markdown" | "text" }) => request<{ document: Document }>(`/sessions/${sessionId}/documents`, json(input)),
  uploadDocuments: (sessionId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("file", file));
    return request<{ documents: Document[] }>(`/sessions/${sessionId}/documents`, { method: "POST", body: form });
  },
  document: (sessionId: string, documentId: string) => request<{ document: Document }>(`/sessions/${sessionId}/documents/${documentId}`),
  saveDocument: (sessionId: string, documentId: string, patch: { content?: string; title?: string }) => request<{ document: Document }>(`/sessions/${sessionId}/documents/${documentId}`, json(patch, "PUT")),
  deleteDocument: (sessionId: string, documentId: string) => request<{ ok: true }>(`/sessions/${sessionId}/documents/${documentId}`, { method: "DELETE" }),
  exportUrl: (sessionId: string, documentId: string, format: "markdown" | "text") => `/api/sessions/${sessionId}/documents/${documentId}/export?format=${format}`,
  applyRewrite: (sessionId: string, documentId: string, jobId: string) => request<{ document: Document }>(`/sessions/${sessionId}/documents/${documentId}/rewrite`, json({ jobId })),
  applyRewriteAll: (sessionId: string, documentId: string, jobId: string, indexes: number[]) => request<{ document: Document }>(`/sessions/${sessionId}/documents/${documentId}/rewrite-all`, json({ jobId, indexes })),
  context: (sessionId: string) => request<{ items: ContextView[]; totalTokens: number; budgetTokens: number }>(`/sessions/${sessionId}/context`),
  uploadContext: (sessionId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("file", file));
    return request<{ session: Session; items: ContextItem[] }>(`/sessions/${sessionId}/context/upload`, { method: "POST", body: form });
  },
  pasteContext: (sessionId: string, name: string, text: string) => request<{ session: Session; item: ContextItem }>(`/sessions/${sessionId}/context/paste`, json({ name, text })),
  folderContext: (sessionId: string, path: string) => request<{ session: Session; collection: ContextCollection }>(`/sessions/${sessionId}/context/folder`, json({ path })),
  importContext: (sessionId: string, fromSessionId: string, documents = true) => request<{ session: Session }>(`/sessions/${sessionId}/context/import`, json({ fromSessionId, documents })),
  removeContext: (sessionId: string, itemId: string) => request<{ session: Session }>(`/sessions/${sessionId}/context/${itemId}`, { method: "DELETE" }),
  contextText: (itemId: string) => request<{ item: ContextItem; text: string }>(`/context/${itemId}`),
  audit: (sessionId: string) => request<{ entries: AuditEntry[] }>(`/sessions/${sessionId}/audit?limit=200`),
  auditEntry: (sessionId: string, entryId: string) => request<{ entry: AuditEntry; before: string | null; after: string | null }>(`/sessions/${sessionId}/audit/${entryId}`),
  research: (sessionId: string) => request<{ records: ResearchRecord[]; hasResearch: boolean }>(`/sessions/${sessionId}/research`),
  factChecks: (sessionId: string) => request<{ runs: FactCheckRun[] }>(`/sessions/${sessionId}/factchecks`),
  novel: (sessionId: string) => request<{ novel: NovelState | null }>(`/sessions/${sessionId}/novel`),
  saveNovel: (sessionId: string, patch: { blueprint?: NovelState["blueprint"]; approved?: boolean; settings?: Partial<NovelState["settings"]> }) => request<{ novel: NovelState }>(`/sessions/${sessionId}/novel`, json(patch, "PUT")),
  estimate: (sessionId: string, action: string, params: Record<string, unknown>, choice: { provider?: ProviderKind; model?: string } = {}) =>
    request<{ estimate: CostEstimate }>(`/sessions/${sessionId}/actions/${action}/estimate`, json({ params, ...choice })),
  run: (sessionId: string, action: string, params: Record<string, unknown>, choice: { provider?: ProviderKind; model?: string } = {}) =>
    request<{ job: Job }>(`/sessions/${sessionId}/actions/${action}/run`, json({ params, ...choice })),
  jobs: (sessionId: string) => request<{ jobs: Job[] }>(`/jobs?sessionId=${sessionId}`),
  job: (jobId: string) => request<{ job: Job }>(`/jobs/${jobId}`),
  cancelJob: (jobId: string) => request<{ cancelled: boolean }>(`/jobs/${jobId}/cancel`, { method: "POST" }),
  lint: (text: string) => request<{ issues: LintIssue[] }>("/lint", json({ text })),
};

export const subscribeJobs = (sessionId: string, onJob: (job: Job) => void): (() => void) => {
  const source = new EventSource(`/api/jobs/events?sessionId=${encodeURIComponent(sessionId)}`);
  source.addEventListener("job", (event) => {
    try {
      onJob(JSON.parse((event as MessageEvent).data) as Job);
    } catch {
      return;
    }
  });
  return () => source.close();
};

export const formatUsd = (usd: number) => (usd === 0 ? "$0.00" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

export const formatTokens = (tokens: number) => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens));

export const timeAgo = (iso: string) => {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
