import type { AuditService } from "../audit/service.js";
import { plainText } from "../lint/markdown.js";
import type { Storage } from "../storage/storage.js";
import type {
  Actor,
  AiTrace,
  Document,
  DocumentKind,
  NovelState,
  Session,
  TemplateKind,
  TemplateSettings,
} from "../types.js";
import { countWords, id, now, sha256, TextoicError, titleFromText } from "../util.js";
import { renderBlueprint } from "../templates/novel/render.js";

export interface CreateSessionOptions {
  title?: string;
  template?: TemplateKind;
  templateSettings?: TemplateSettings;
  initialContent?: string;
}

export interface DocumentInput {
  title?: string;
  content: string;
  kind?: DocumentKind;
}

export interface ChangeMeta {
  actor: Actor;
  action?: string;
  summary?: string;
  ai?: AiTrace;
}

export type ExportFormat = "markdown" | "text";

const HUMAN: Actor = { kind: "human" };

export class SessionService {
  private readonly storage: Storage;
  private readonly audit: AuditService;

  constructor(storage: Storage, audit: AuditService) {
    this.storage = storage;
    this.audit = audit;
  }

  async list(): Promise<Session[]> {
    const sessions = await this.storage.sessions.list();
    return sessions.sort((one, other) => other.updatedAt.localeCompare(one.updatedAt));
  }

  async get(sessionId: string): Promise<Session> {
    const session = await this.storage.sessions.get(sessionId);
    if (!session) {
      throw new TextoicError(`No session ${sessionId}.`, 404);
    }

    return session;
  }

  async create(options: CreateSessionOptions = {}): Promise<Session> {
    const template = options.template ?? "blank";
    const stamp = now();
    const session: Session = {
      id: id(),
      title: options.title?.trim() || defaultTitle(template, options.templateSettings),
      createdAt: stamp,
      updatedAt: stamp,
      archived: false,
      template,
      templateSettings: options.templateSettings,
      documentIds: [],
      activeDocumentId: null,
      contextItemIds: [],
    };
    if (template === "novel" && isNovelSettings(options.templateSettings)) {
      session.novel = {
        settings: options.templateSettings,
        blueprint: {},
        approved: false,
        updatedAt: stamp,
      };
    }

    await this.storage.sessions.put(session);
    await this.audit.record({
      sessionId: session.id,
      actor: HUMAN,
      action: "session.create",
      summary: `Created session "${session.title}" (${template})`,
      target: { type: "session", id: session.id, title: session.title },
    });
    if (template !== "novel") {
      await this.createDocument(
        session.id,
        {
          title: session.title,
          content: options.initialContent ?? "",
          kind: "markdown",
        },
        { actor: HUMAN, action: "document.create" },
      );
    }

    return this.get(session.id);
  }

  async update(
    sessionId: string,
    patch: { title?: string; archived?: boolean; activeDocumentId?: string | null },
  ): Promise<Session> {
    const session = await this.get(sessionId);
    if (patch.activeDocumentId && !session.documentIds.includes(patch.activeDocumentId)) {
      throw new TextoicError("That document is not in this session.", 400);
    }

    const updated: Session = {
      ...session,
      title: patch.title?.trim() || session.title,
      archived: patch.archived ?? session.archived,
      activeDocumentId:
        patch.activeDocumentId === undefined ? session.activeDocumentId : patch.activeDocumentId,
      updatedAt: now(),
    };
    await this.storage.sessions.put(updated);
    if (patch.title && patch.title !== session.title) {
      await this.audit.record({
        sessionId,
        actor: HUMAN,
        action: "session.rename",
        summary: `Renamed session to "${updated.title}"`,
        target: { type: "session", id: sessionId, title: updated.title },
      });
    }

    if (patch.archived !== undefined && patch.archived !== session.archived) {
      await this.audit.record({
        sessionId,
        actor: HUMAN,
        action: patch.archived ? "session.archive" : "session.restore",
        summary: patch.archived ? "Archived session" : "Restored session",
        target: { type: "session", id: sessionId, title: updated.title },
      });
    }

    return updated;
  }

  async remove(sessionId: string): Promise<void> {
    await this.get(sessionId);
    await this.storage.sessions.remove(sessionId);
  }

  async touch(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    await this.storage.sessions.put({ ...session, updatedAt: now() });
  }

  async listDocuments(sessionId: string): Promise<Document[]> {
    const session = await this.get(sessionId);
    const documents = await this.storage.documents.list(sessionId);
    const order = new Map(session.documentIds.map((one, index) => [one, index]));
    return documents.sort(
      (one, other) => (order.get(one.id) ?? 0) - (order.get(other.id) ?? 0),
    );
  }

  async getDocument(sessionId: string, documentId: string): Promise<Document> {
    const document = await this.storage.documents.get(sessionId, documentId);
    if (!document) {
      throw new TextoicError(`No document ${documentId} in session ${sessionId}.`, 404);
    }

    return document;
  }

  async createDocument(
    sessionId: string,
    input: DocumentInput,
    meta: ChangeMeta,
  ): Promise<Document> {
    const session = await this.get(sessionId);
    const stamp = now();
    const content = input.content ?? "";
    const document: Document = {
      id: id(),
      sessionId,
      title: input.title?.trim() || titleFromText(content, "Untitled"),
      kind: input.kind ?? "markdown",
      content,
      contentHash: sha256(content),
      wordCount: countWords(content),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.storage.documents.put(document);
    await this.storage.sessions.put({
      ...session,
      documentIds: [...session.documentIds, document.id],
      activeDocumentId: document.id,
      updatedAt: stamp,
    });
    const target = { type: "document" as const, id: document.id, title: document.title };
    if (content === "") {
      await this.audit.record({
        sessionId,
        actor: meta.actor,
        action: meta.action ?? "document.create",
        summary: meta.summary ?? `Created document "${document.title}"`,
        target,
        ai: meta.ai,
      });
    } else {
      await this.audit.recordTextChange({
        sessionId,
        actor: meta.actor,
        action: meta.action ?? "document.create",
        summary: meta.summary ?? `Created document "${document.title}"`,
        target,
        ai: meta.ai,
        before: "",
        after: content,
      });
    }

    return document;
  }

  async updateDocument(
    sessionId: string,
    documentId: string,
    patch: { content?: string; title?: string },
    meta: ChangeMeta,
  ): Promise<Document> {
    const document = await this.getDocument(sessionId, documentId);
    const content = patch.content ?? document.content;
    const title = patch.title?.trim() || document.title;
    if (content === document.content && title === document.title) {
      return document;
    }

    const updated: Document = {
      ...document,
      title,
      content,
      contentHash: sha256(content),
      wordCount: countWords(content),
      updatedAt: now(),
    };
    await this.storage.documents.put(updated);
    await this.touch(sessionId);
    const target = { type: "document" as const, id: documentId, title };
    if (content !== document.content) {
      await this.audit.recordTextChange({
        sessionId,
        actor: meta.actor,
        action: meta.action ?? (meta.actor.kind === "human" ? "document.edit" : "document.rewrite"),
        summary: meta.summary ?? (meta.actor.kind === "human" ? "Edited text" : "AI rewrote the text"),
        target,
        ai: meta.ai,
        before: document.content,
        after: content,
      });
    } else {
      await this.audit.record({
        sessionId,
        actor: meta.actor,
        action: "document.rename",
        summary: `Renamed document to "${title}"`,
        target,
      });
    }

    return updated;
  }

  async removeDocument(sessionId: string, documentId: string): Promise<void> {
    const session = await this.get(sessionId);
    const document = await this.getDocument(sessionId, documentId);
    await this.storage.documents.remove(sessionId, documentId);
    const documentIds = session.documentIds.filter((one) => one !== documentId);
    await this.storage.sessions.put({
      ...session,
      documentIds,
      activeDocumentId:
        session.activeDocumentId === documentId ? documentIds[0] ?? null : session.activeDocumentId,
      updatedAt: now(),
    });
    await this.audit.record({
      sessionId,
      actor: HUMAN,
      action: "document.delete",
      summary: `Deleted document "${document.title}"`,
      target: { type: "document", id: documentId, title: document.title },
    });
  }

  async exportDocument(sessionId: string, documentId: string, format: ExportFormat) {
    const document = await this.getDocument(sessionId, documentId);
    return format === "text" ? plainText(document.content) : document.content;
  }

  async saveNovelProgress(sessionId: string, novel: NovelState): Promise<Session> {
    const session = await this.get(sessionId);
    const updated: Session = { ...session, novel: { ...novel, updatedAt: now() }, updatedAt: now() };
    await this.storage.sessions.put(updated);
    return updated;
  }

  async setNovel(sessionId: string, novel: NovelState, meta: ChangeMeta, previous?: NovelState): Promise<Session> {
    const session = await this.get(sessionId);
    const baseline = previous ?? session.novel;
    const before = baseline ? renderBlueprint(baseline.blueprint, baseline.settings) : "";
    const after = renderBlueprint(novel.blueprint, novel.settings);
    const updated: Session = { ...session, novel: { ...novel, updatedAt: now() }, updatedAt: now() };
    await this.storage.sessions.put(updated);
    if (before !== after) {
      await this.audit.recordTextChange({
        sessionId,
        actor: meta.actor,
        action: meta.action ?? "blueprint.edit",
        summary: meta.summary ?? (meta.actor.kind === "human" ? "Edited the novel blueprint" : "AI generated blueprint sections"),
        target: { type: "blueprint", id: sessionId, title: "Novel blueprint" },
        ai: meta.ai,
        before,
        after,
      });
    } else if (baseline?.approved !== novel.approved) {
      await this.audit.record({
        sessionId,
        actor: meta.actor,
        action: novel.approved ? "blueprint.approve" : "blueprint.unapprove",
        summary: novel.approved ? "Approved the novel blueprint" : "Reopened the novel blueprint",
        target: { type: "blueprint", id: sessionId, title: "Novel blueprint" },
      });
    }

    return updated;
  }
}

const isNovelSettings = (value: TemplateSettings | undefined): value is NovelState["settings"] =>
  value !== undefined && "wordCount" in value && "genre" in value;

const defaultTitle = (template: TemplateKind, settings?: TemplateSettings) => {
  const prompt = settings && "prompt" in settings ? settings.prompt.trim() : "";
  const head = prompt ? prompt.split(/[.\n!?]/u)[0].slice(0, 60) : "";
  const labels: Record<TemplateKind, string> = {
    blank: "Untitled",
    tweet: "Tweet",
    article: "Article",
    novel: "Novel",
  };
  return head ? `${labels[template]}: ${head}` : `${labels[template]} ${new Date().toLocaleDateString()}`;
};
