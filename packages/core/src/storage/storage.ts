import type {
  AuditEntry,
  ContextCollection,
  ContextItem,
  Document,
  FactCheckRun,
  ResearchRecord,
  Session,
  Settings,
} from "../types.js";

export interface AuditListOptions {
  limit?: number;
  before?: string;
}

export interface Storage {
  settings: {
    get(): Promise<Settings | null>;
    set(settings: Settings): Promise<void>;
  };
  sessions: {
    list(): Promise<Session[]>;
    get(id: string): Promise<Session | null>;
    put(session: Session): Promise<void>;
    remove(id: string): Promise<void>;
  };
  documents: {
    get(sessionId: string, id: string): Promise<Document | null>;
    put(document: Document): Promise<void>;
    remove(sessionId: string, id: string): Promise<void>;
    list(sessionId: string): Promise<Document[]>;
  };
  blobs: {
    has(hash: string): Promise<boolean>;
    get(hash: string): Promise<string | null>;
    put(hash: string, text: string): Promise<void>;
  };
  context: {
    get(id: string): Promise<ContextItem | null>;
    put(item: ContextItem): Promise<void>;
    list(): Promise<ContextItem[]>;
    getCollection(id: string): Promise<ContextCollection | null>;
    putCollection(collection: ContextCollection): Promise<void>;
  };
  audit: {
    append(entry: AuditEntry): Promise<void>;
    replaceLast(sessionId: string, entry: AuditEntry): Promise<void>;
    last(sessionId: string): Promise<AuditEntry | null>;
    list(sessionId: string, options?: AuditListOptions): Promise<AuditEntry[]>;
    get(sessionId: string, id: string): Promise<AuditEntry | null>;
  };
  factChecks: {
    put(run: FactCheckRun): Promise<void>;
    get(sessionId: string, id: string): Promise<FactCheckRun | null>;
    list(sessionId: string): Promise<FactCheckRun[]>;
  };
  research: {
    put(record: ResearchRecord): Promise<void>;
    list(sessionId: string): Promise<ResearchRecord[]>;
  };
}

export const pageOf = (
  entries: AuditEntry[],
  { limit = 100, before }: AuditListOptions = {},
): AuditEntry[] => {
  const sorted = [...entries].sort((one, other) =>
    other.at.localeCompare(one.at),
  );
  const from = before ? sorted.findIndex((entry) => entry.id === before) + 1 : 0;
  return sorted.slice(from, from + limit);
};
