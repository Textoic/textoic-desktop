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
import { pageOf, type AuditListOptions, type Storage } from "./storage.js";

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryStorage implements Storage {
  private settingsValue: Settings | null = null;
  private readonly sessionMap = new Map<string, Session>();
  private readonly documentMap = new Map<string, Document>();
  private readonly blobMap = new Map<string, string>();
  private readonly contextMap = new Map<string, ContextItem>();
  private readonly collectionMap = new Map<string, ContextCollection>();
  private readonly auditMap = new Map<string, AuditEntry[]>();
  private readonly factCheckMap = new Map<string, FactCheckRun>();
  private readonly researchMap = new Map<string, ResearchRecord>();

  readonly settings = {
    get: async () => (this.settingsValue ? clone(this.settingsValue) : null),
    set: async (settings: Settings) => {
      this.settingsValue = clone(settings);
    },
  };

  readonly sessions = {
    list: async () => [...this.sessionMap.values()].map(clone),
    get: async (id: string) => {
      const found = this.sessionMap.get(id);
      return found ? clone(found) : null;
    },
    put: async (session: Session) => {
      this.sessionMap.set(session.id, clone(session));
    },
    remove: async (id: string) => {
      this.sessionMap.delete(id);
    },
  };

  readonly documents = {
    get: async (sessionId: string, id: string) => {
      const found = this.documentMap.get(`${sessionId}/${id}`);
      return found ? clone(found) : null;
    },
    put: async (document: Document) => {
      this.documentMap.set(`${document.sessionId}/${document.id}`, clone(document));
    },
    remove: async (sessionId: string, id: string) => {
      this.documentMap.delete(`${sessionId}/${id}`);
    },
    list: async (sessionId: string) =>
      [...this.documentMap.values()]
        .filter((document) => document.sessionId === sessionId)
        .map(clone),
  };

  readonly blobs = {
    has: async (hash: string) => this.blobMap.has(hash),
    get: async (hash: string) => this.blobMap.get(hash) ?? null,
    put: async (hash: string, text: string) => {
      this.blobMap.set(hash, text);
    },
  };

  readonly context = {
    get: async (id: string) => {
      const found = this.contextMap.get(id);
      return found ? clone(found) : null;
    },
    put: async (item: ContextItem) => {
      this.contextMap.set(item.id, clone(item));
    },
    list: async () => [...this.contextMap.values()].map(clone),
    getCollection: async (id: string) => {
      const found = this.collectionMap.get(id);
      return found ? clone(found) : null;
    },
    putCollection: async (collection: ContextCollection) => {
      this.collectionMap.set(collection.id, clone(collection));
    },
  };

  readonly audit = {
    append: async (entry: AuditEntry) => {
      const entries = this.auditMap.get(entry.sessionId) ?? [];
      entries.push(clone(entry));
      this.auditMap.set(entry.sessionId, entries);
    },
    replaceLast: async (sessionId: string, entry: AuditEntry) => {
      const entries = this.auditMap.get(sessionId) ?? [];
      entries.splice(entries.length - 1, 1, clone(entry));
      this.auditMap.set(sessionId, entries);
    },
    last: async (sessionId: string) => {
      const entries = this.auditMap.get(sessionId) ?? [];
      const last = entries[entries.length - 1];
      return last ? clone(last) : null;
    },
    list: async (sessionId: string, options?: AuditListOptions) =>
      pageOf(this.auditMap.get(sessionId) ?? [], options).map(clone),
    get: async (sessionId: string, id: string) => {
      const found = (this.auditMap.get(sessionId) ?? []).find(
        (entry) => entry.id === id,
      );
      return found ? clone(found) : null;
    },
  };

  readonly factChecks = {
    put: async (run: FactCheckRun) => {
      this.factCheckMap.set(`${run.sessionId}/${run.id}`, clone(run));
    },
    get: async (sessionId: string, id: string) => {
      const found = this.factCheckMap.get(`${sessionId}/${id}`);
      return found ? clone(found) : null;
    },
    list: async (sessionId: string) =>
      [...this.factCheckMap.values()]
        .filter((run) => run.sessionId === sessionId)
        .map(clone),
  };

  readonly research = {
    put: async (record: ResearchRecord) => {
      this.researchMap.set(`${record.sessionId}/${record.id}`, clone(record));
    },
    list: async (sessionId: string) =>
      [...this.researchMap.values()]
        .filter((record) => record.sessionId === sessionId)
        .map(clone),
  };
}
