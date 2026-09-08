import type { Storage } from "../storage/storage.js";
import type {
  Actor,
  AiTrace,
  AuditEntry,
  AuditTargetType,
} from "../types.js";
import { id, now, sha256 } from "../util.js";
import { describeChange, summarizeChange, unifiedDiff } from "./diff.js";

export interface RecordOptions {
  sessionId: string;
  actor: Actor;
  action: string;
  summary: string;
  target?: { type: AuditTargetType; id: string; title?: string };
  ai?: AiTrace;
}

export interface TextChangeOptions extends RecordOptions {
  before: string;
  after: string;
}

const HUMAN_EDIT = "document.edit";

export class AuditService {
  private readonly storage: Storage;
  private readonly coalesceMs: () => number;

  constructor(storage: Storage, coalesceMs: () => number) {
    this.storage = storage;
    this.coalesceMs = coalesceMs;
  }

  async record(options: RecordOptions): Promise<AuditEntry> {
    const entry: AuditEntry = { id: id(), at: now(), ...options };
    await this.storage.audit.append(entry);
    return entry;
  }

  async recordTextChange(options: TextChangeOptions): Promise<AuditEntry | null> {
    const { before, after, ...rest } = options;
    if (before === after) {
      return null;
    }

    const beforeHash = sha256(before);
    const afterHash = sha256(after);
    await Promise.all([
      this.storage.blobs.put(beforeHash, before),
      this.storage.blobs.put(afterHash, after),
    ]);

    const previous = await this.storage.audit.last(options.sessionId);
    const coalesced = this.coalescible(previous, options)
      ? await this.coalesce(previous as AuditEntry, after, afterHash)
      : null;
    if (coalesced) {
      return coalesced;
    }

    const entry: AuditEntry = {
      id: id(),
      at: now(),
      ...rest,
      summary: `${rest.summary} (${describeChange(summarizeChange(before, after))})`,
      before: beforeHash,
      after: afterHash,
      diff: unifiedDiff(before, after, rest.target?.title ?? "document"),
    };
    await this.storage.audit.append(entry);
    return entry;
  }

  private coalescible(previous: AuditEntry | null, options: TextChangeOptions) {
    return (
      previous !== null &&
      options.actor.kind === "human" &&
      previous.actor.kind === "human" &&
      options.action === HUMAN_EDIT &&
      previous.action === HUMAN_EDIT &&
      previous.target?.id === options.target?.id &&
      previous.before !== undefined &&
      Date.now() - Date.parse(previous.at) < this.coalesceMs()
    );
  }

  private async coalesce(previous: AuditEntry, after: string, afterHash: string) {
    const original = await this.storage.blobs.get(previous.before as string);
    if (original === null) {
      return null;
    }

    if (original === after) {
      return previous;
    }

    const entry: AuditEntry = {
      ...previous,
      at: now(),
      after: afterHash,
      summary: `Edited text (${describeChange(summarizeChange(original, after))})`,
      diff: unifiedDiff(original, after, previous.target?.title ?? "document"),
    };
    await this.storage.audit.replaceLast(previous.sessionId, entry);
    return entry;
  }

  list(sessionId: string, options?: { limit?: number; before?: string }) {
    return this.storage.audit.list(sessionId, options);
  }

  get(sessionId: string, entryId: string) {
    return this.storage.audit.get(sessionId, entryId);
  }

  async snapshot(hash: string) {
    return this.storage.blobs.get(hash);
  }
}
