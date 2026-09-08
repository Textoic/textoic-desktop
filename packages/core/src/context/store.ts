import { basename } from "node:path";
import type { AuditService } from "../audit/service.js";
import { chunkText, outlineOf } from "../ingest/chunk.js";
import { convertUpload } from "../ingest/convert.js";
import { scanFolder } from "../ingest/folder.js";
import type { Storage } from "../storage/storage.js";
import type {
  ContextCollection,
  ContextItem,
  ContextKind,
  ContextSource,
  Session,
} from "../types.js";
import { countWords, estimateTokens, now, sha256, TextoicError } from "../util.js";
import { Bm25Index } from "./bm25.js";

export interface IngestOptions {
  name: string;
  text: string;
  kind: ContextKind;
  source: ContextSource;
}

export interface SearchHit {
  item: ContextItem;
  chunkId: string;
  score: number;
  text: string;
}

type SessionIndex = { manifest: string; index: Bm25Index; items: Map<string, ContextItem> };

const EXCERPT = 400;

export class ContextService {
  private readonly storage: Storage;
  private readonly audit: AuditService;
  private readonly indexes = new Map<string, SessionIndex>();

  constructor(storage: Storage, audit: AuditService) {
    this.storage = storage;
    this.audit = audit;
  }

  async ingestText(options: IngestOptions): Promise<ContextItem> {
    const text = options.text.replace(/\r\n?/gu, "\n");
    if (text.trim() === "") {
      throw new TextoicError(`${options.name} is empty.`, 400);
    }

    const hash = sha256(text);
    const existing = await this.storage.context.get(hash);
    if (existing) {
      return existing;
    }

    await this.storage.blobs.put(hash, text);
    const item: ContextItem = {
      id: hash,
      name: options.name,
      kind: options.kind,
      bytes: Buffer.byteLength(text, "utf8"),
      words: countWords(text),
      tokens: estimateTokens(text),
      createdAt: now(),
      source: options.source,
      chunks: chunkText(text, options.kind),
      digests: {},
      outline: outlineOf(text, options.kind),
    };
    await this.storage.context.put(item);
    return item;
  }

  async ingestUpload(fileName: string, bytes: Uint8Array): Promise<ContextItem> {
    const converted = await convertUpload(fileName, bytes);
    return this.ingestText({
      name: basename(fileName),
      text: converted.text,
      kind: converted.kind,
      source: { type: "upload", fileName: basename(fileName) },
    });
  }

  async ingestFolder(root: string): Promise<ContextCollection> {
    const scan = await scanFolder(root);
    if (scan.files.length === 0) {
      throw new TextoicError(`No readable text files under ${root}.`, 400);
    }

    const items: ContextItem[] = [];
    for (const file of scan.files) {
      const item = await this.ingestText({
        name: file.path,
        text: file.text,
        kind: file.kind,
        source: { type: "folder", root, path: file.path },
      });
      items.push(item);
    }

    const manifest = sha256(items.map((item) => `${item.name}:${item.id}`).join("\n"));
    const collection: ContextCollection = {
      id: manifest,
      name: basename(root) || root,
      root,
      createdAt: now(),
      itemIds: items.map((item) => item.id),
      skipped: scan.skipped,
      tokens: items.reduce((total, item) => total + item.tokens, 0),
    };
    await this.storage.context.putCollection(collection);
    await Promise.all(
      items.map((item) =>
        item.collectionId === manifest
          ? Promise.resolve()
          : this.storage.context.put({ ...item, collectionId: manifest }),
      ),
    );
    return collection;
  }

  async get(itemId: string): Promise<ContextItem> {
    const item = await this.storage.context.get(itemId);
    if (!item) {
      throw new TextoicError(`No context item ${itemId}.`, 404);
    }

    return item;
  }

  async text(itemId: string): Promise<string> {
    const text = await this.storage.blobs.get(itemId);
    if (text === null) {
      throw new TextoicError(`The content of ${itemId} is missing.`, 404);
    }

    return text;
  }

  async chunk(item: ContextItem, chunkId: string): Promise<string> {
    const chunk = item.chunks.find((one) => one.id === chunkId);
    if (!chunk) {
      throw new TextoicError(`No chunk ${chunkId} in ${item.name}.`, 404);
    }

    const text = await this.text(item.id);
    return text.slice(chunk.at, chunk.end);
  }

  async put(item: ContextItem): Promise<void> {
    await this.storage.context.put(item);
  }

  async itemsFor(sessionId: string): Promise<ContextItem[]> {
    const session = await this.session(sessionId);
    const items = await Promise.all(
      session.contextItemIds.map((itemId) => this.storage.context.get(itemId)),
    );
    return items.filter((item): item is ContextItem => item !== null);
  }

  async attach(sessionId: string, itemIds: string[], note?: string): Promise<Session> {
    const session = await this.session(sessionId);
    const fresh = itemIds.filter((itemId) => !session.contextItemIds.includes(itemId));
    if (fresh.length === 0) {
      return session;
    }

    const items = await Promise.all(fresh.map((itemId) => this.get(itemId)));
    const updated = {
      ...session,
      contextItemIds: [...session.contextItemIds, ...fresh],
      updatedAt: now(),
    };
    await this.storage.sessions.put(updated);
    await this.audit.record({
      sessionId,
      actor: { kind: "human" },
      action: "context.add",
      summary:
        note ??
        `Added ${items.length} context item${items.length === 1 ? "" : "s"}: ${items
          .map((item) => item.name)
          .slice(0, 5)
          .join(", ")}${items.length > 5 ? "…" : ""}`,
      target: { type: "context", id: items[0].id, title: items[0].name },
    });
    return updated;
  }

  async detach(sessionId: string, itemId: string): Promise<Session> {
    const session = await this.session(sessionId);
    const item = await this.storage.context.get(itemId);
    const updated = {
      ...session,
      contextItemIds: session.contextItemIds.filter((one) => one !== itemId),
      updatedAt: now(),
    };
    await this.storage.sessions.put(updated);
    await this.audit.record({
      sessionId,
      actor: { kind: "human" },
      action: "context.remove",
      summary: `Removed context item ${item?.name ?? itemId}`,
      target: { type: "context", id: itemId, title: item?.name },
    });
    return updated;
  }

  async importFromSession(
    sessionId: string,
    fromSessionId: string,
    options: { itemIds?: string[]; documents?: boolean } = {},
  ): Promise<Session> {
    const from = await this.session(fromSessionId);
    const wanted = options.itemIds ?? from.contextItemIds;
    const itemIds = wanted.filter((itemId) => from.contextItemIds.includes(itemId));
    if (options.documents ?? true) {
      const documents = await this.storage.documents.list(fromSessionId);
      for (const document of documents) {
        if (document.content.trim() === "") {
          continue;
        }

        const item = await this.ingestText({
          name: `${from.title} / ${document.title}`,
          text: document.content,
          kind: "document",
          source: { type: "session", sessionId: fromSessionId, documentId: document.id },
        });
        itemIds.push(item.id);
      }
    }

    return this.attach(sessionId, itemIds, `Imported context from session "${from.title}"`);
  }

  async manifest(sessionId: string): Promise<string> {
    const session = await this.session(sessionId);
    return sha256([...session.contextItemIds].sort().join("\n"));
  }

  async search(sessionId: string, query: string, limit = 8): Promise<SearchHit[]> {
    const { index, items } = await this.indexFor(sessionId);
    const hits = index.search(query, limit);
    const found: SearchHit[] = [];
    for (const hit of hits) {
      const [itemId, chunkId] = hit.id.split("#");
      const item = items.get(itemId);
      if (!item) {
        continue;
      }

      found.push({ item, chunkId, score: hit.score, text: await this.chunk(item, chunkId) });
    }

    return found;
  }

  excerpt(text: string, most = EXCERPT) {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    return collapsed.length > most ? `${collapsed.slice(0, most - 1)}…` : collapsed;
  }

  private async indexFor(sessionId: string): Promise<SessionIndex> {
    const manifest = await this.manifest(sessionId);
    const cached = this.indexes.get(sessionId);
    if (cached && cached.manifest === manifest) {
      return cached;
    }

    const items = await this.itemsFor(sessionId);
    const index = new Bm25Index();
    for (const item of items) {
      const text = await this.text(item.id);
      for (const chunk of item.chunks) {
        index.add({
          id: `${item.id}#${chunk.id}`,
          text: `${chunk.heading ?? ""} ${text.slice(chunk.at, chunk.end)}`,
        });
      }
    }

    const built = { manifest, index, items: new Map(items.map((item) => [item.id, item])) };
    this.indexes.set(sessionId, built);
    return built;
  }

  private async session(sessionId: string): Promise<Session> {
    const session = await this.storage.sessions.get(sessionId);
    if (!session) {
      throw new TextoicError(`No session ${sessionId}.`, 404);
    }

    return session;
  }
}
