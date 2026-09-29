import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  PROMPT_MAX_CHARS,
  ProviderError,
  TextoicError,
  redactedSettings,
  ruleDefaults,
  ruleIds,
  type Actor,
  type NovelState,
  type ProviderKind,
  type Rewrite,
  type Textoic,
} from "@textoic/core";
import { withRewrites } from "@textoic/enlint-lsp/rewrite";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";

export interface AppOptions {
  engine: Textoic;
  webDir?: string;
}

const HUMAN: Actor = { kind: "human" };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const statusOf = (cause: unknown) =>
  cause instanceof TextoicError || cause instanceof ProviderError ? cause.status : 500;

const body = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const parsed = await c.req.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const providerChoice = (input: Record<string, unknown>) => ({
  provider: input.provider === "ollama" || input.provider === "openrouter" ? (input.provider as ProviderKind) : undefined,
  model: typeof input.model === "string" && input.model !== "" ? input.model : undefined,
});

const paramsOf = (input: Record<string, unknown>) =>
  typeof input.params === "object" && input.params !== null ? (input.params as Record<string, unknown>) : {};

export const createApp = ({ engine, webDir }: AppOptions) => {
  const app = new Hono();

  app.onError((cause, c) => {
    const status = statusOf(cause);
    if (status >= 500) {
      console.error(cause);
    }

    return c.json({ error: cause instanceof Error ? cause.message : String(cause) }, status as 400);
  });

  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true, name: "textoic", version: "0.1.0" }));

  api.get("/settings", async (c) => {
    const settings = await engine.settings();
    return c.json({ settings: redactedSettings(settings), rules: ruleIds, ruleDefaults: ruleDefaults(), promptMaxChars: PROMPT_MAX_CHARS });
  });

  api.put("/settings", async (c) => {
    const settings = await engine.updateSettings(await body(c));
    return c.json({ settings: redactedSettings(settings) });
  });

  api.get("/models", async (c) => {
    const kind = c.req.query("provider");
    const models = await engine.models(kind === "ollama" || kind === "openrouter" ? kind : undefined);
    return c.json({ models });
  });

  api.get("/actions", (c) => c.json({ actions: engine.actions.list() }));

  api.get("/sessions", async (c) => c.json({ sessions: await engine.sessions.list() }));

  api.post("/sessions", async (c) => {
    const input = await body(c);
    const template = input.template;
    const session = await engine.sessions.create({
      title: typeof input.title === "string" ? input.title : undefined,
      template: template === "tweet" || template === "article" || template === "novel" ? template : "blank",
      templateSettings: typeof input.templateSettings === "object" && input.templateSettings !== null ? (input.templateSettings as never) : undefined,
      initialContent: typeof input.initialContent === "string" ? input.initialContent : undefined,
    });
    return c.json({ session, documents: await engine.sessions.listDocuments(session.id) }, 201);
  });

  api.get("/sessions/:id", async (c) => {
    const session = await engine.sessions.get(c.req.param("id"));
    return c.json({ session, documents: await engine.sessions.listDocuments(session.id) });
  });

  api.patch("/sessions/:id", async (c) => {
    const input = await body(c);
    const session = await engine.sessions.update(c.req.param("id"), {
      title: typeof input.title === "string" ? input.title : undefined,
      archived: typeof input.archived === "boolean" ? input.archived : undefined,
      activeDocumentId: typeof input.activeDocumentId === "string" || input.activeDocumentId === null ? (input.activeDocumentId as string | null) : undefined,
    });
    return c.json({ session });
  });

  api.delete("/sessions/:id", async (c) => {
    await engine.sessions.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/sessions/:id/documents", async (c) => c.json({ documents: await engine.sessions.listDocuments(c.req.param("id")) }));

  api.post("/sessions/:id/documents", async (c) => {
    const sessionId = c.req.param("id");
    const type = c.req.header("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await c.req.parseBody({ all: true });
      const files = ([] as unknown[]).concat(form.file ?? form.files ?? []).filter((one): one is File => one instanceof File);
      if (files.length === 0) {
        throw new TextoicError("Attach at least one file.", 400);
      }

      const { convertUpload } = await import("@textoic/core");
      const created = [];
      for (const file of files) {
        const converted = await convertUpload(file.name, new Uint8Array(await file.arrayBuffer()));
        created.push(await engine.sessions.createDocument(sessionId, { title: file.name.replace(/\.[^.]+$/u, ""), content: converted.text, kind: converted.kind === "markdown" ? "markdown" : "text" }, { actor: HUMAN, action: "document.upload", summary: `Uploaded ${file.name}` }));
      }

      return c.json({ documents: created }, 201);
    }

    const input = await body(c);
    const document = await engine.sessions.createDocument(
      sessionId,
      { title: typeof input.title === "string" ? input.title : undefined, content: typeof input.content === "string" ? input.content : "", kind: input.kind === "text" ? "text" : "markdown" },
      { actor: HUMAN, action: "document.create" },
    );
    return c.json({ document }, 201);
  });

  api.get("/sessions/:id/documents/:docId", async (c) => c.json({ document: await engine.sessions.getDocument(c.req.param("id"), c.req.param("docId")) }));

  api.put("/sessions/:id/documents/:docId", async (c) => {
    const input = await body(c);
    const document = await engine.sessions.updateDocument(
      c.req.param("id"),
      c.req.param("docId"),
      { content: typeof input.content === "string" ? input.content : undefined, title: typeof input.title === "string" ? input.title : undefined },
      { actor: HUMAN },
    );
    return c.json({ document });
  });

  api.delete("/sessions/:id/documents/:docId", async (c) => {
    await engine.sessions.removeDocument(c.req.param("id"), c.req.param("docId"));
    return c.json({ ok: true });
  });

  api.get("/sessions/:id/documents/:docId/export", async (c) => {
    const format = c.req.query("format") === "text" ? "text" : "markdown";
    const document = await engine.sessions.getDocument(c.req.param("id"), c.req.param("docId"));
    const content = await engine.sessions.exportDocument(document.sessionId, document.id, format);
    const name = `${document.title.replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "document"}.${format === "text" ? "txt" : "md"}`;
    return new Response(content, {
      headers: {
        "content-type": format === "text" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  });

  api.post("/sessions/:id/documents/:docId/rewrite", async (c) => {
    const input = await body(c);
    const jobId = typeof input.jobId === "string" ? input.jobId : "";
    const job = engine.jobs.get(jobId);
    const result = job?.result as { rewrite?: Rewrite & { documentId: string; documentHash: string }; trace?: unknown } | undefined;
    if (!job || job.status !== "done" || !result?.rewrite) {
      throw new TextoicError("That rewrite job has no result to apply.", 404);
    }

    const document = await engine.sessions.getDocument(c.req.param("id"), c.req.param("docId"));
    if (result.rewrite.documentId !== document.id || result.rewrite.documentHash !== document.contentHash) {
      throw new TextoicError("The document changed since the rewrite was proposed. Ask for a new rewrite.", 409);
    }

    const { start, end, replacement } = result.rewrite;
    const content = `${document.content.slice(0, start)}${replacement}${document.content.slice(end)}`;
    const entry = job.auditEntryId ? await engine.audit.get(document.sessionId, job.auditEntryId) : null;
    const updated = await engine.sessions.updateDocument(
      document.sessionId,
      document.id,
      { content },
      { actor: entry?.actor ?? { kind: "ai", provider: (await engine.settings()).provider, model: (await engine.settings()).model }, action: "lint.rewrite.apply", summary: "Applied an AI style rewrite", ai: entry?.ai },
    );
    return c.json({ document: updated });
  });

  api.post("/sessions/:id/documents/:docId/rewrite-all", async (c) => {
    const input = await body(c);
    const jobId = typeof input.jobId === "string" ? input.jobId : "";
    const chosen = new Set(Array.isArray(input.indexes) ? input.indexes.filter((index): index is number => typeof index === "number") : []);
    const job = engine.jobs.get(jobId);
    const result = job?.result as { rewriteAll?: { rewrites: Rewrite[]; documentId: string; documentHash: string } } | undefined;
    if (!job || job.status !== "done" || !result?.rewriteAll) {
      throw new TextoicError("That rewrite job has no result to apply.", 404);
    }

    const document = await engine.sessions.getDocument(c.req.param("id"), c.req.param("docId"));
    if (result.rewriteAll.documentId !== document.id || result.rewriteAll.documentHash !== document.contentHash) {
      throw new TextoicError("The document changed since the rewrites were proposed. Ask for new ones.", 409);
    }

    const picked = result.rewriteAll.rewrites.filter((rewrite, index) => chosen.has(index) && rewrite.replacement !== "");
    if (picked.length === 0) {
      throw new TextoicError("Choose at least one rewrite to apply.", 400);
    }

    const content = withRewrites(document.content, picked);
    const entry = job.auditEntryId ? await engine.audit.get(document.sessionId, job.auditEntryId) : null;
    const updated = await engine.sessions.updateDocument(
      document.sessionId,
      document.id,
      { content },
      { actor: entry?.actor ?? { kind: "ai", provider: (await engine.settings()).provider, model: (await engine.settings()).model }, action: "lint.rewriteAll.apply", summary: `Applied ${picked.length} AI style rewrite(s)`, ai: entry?.ai },
    );
    return c.json({ document: updated });
  });

  api.get("/sessions/:id/context", async (c) => {
    const items = await engine.context.itemsFor(c.req.param("id"));
    const settings = await engine.settings();
    return c.json({
      items: items.map((item) => ({ ...item, chunks: item.chunks.length, digest: item.digests[settings.model]?.text ?? null, digestModels: Object.keys(item.digests) })),
      totalTokens: items.reduce((total, item) => total + item.tokens, 0),
      budgetTokens: settings.contextBudgetTokens,
    });
  });

  api.post("/sessions/:id/context/upload", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(form.file ?? form.files ?? []).filter((one): one is File => one instanceof File);
    if (files.length === 0) {
      throw new TextoicError("Attach at least one file.", 400);
    }

    const items = [];
    for (const file of files) {
      items.push(await engine.context.ingestUpload(file.name, new Uint8Array(await file.arrayBuffer())));
    }

    const session = await engine.context.attach(c.req.param("id"), items.map((item) => item.id));
    return c.json({ session, items }, 201);
  });

  api.post("/sessions/:id/context/paste", async (c) => {
    const input = await body(c);
    if (typeof input.text !== "string" || input.text.trim() === "") {
      throw new TextoicError("Paste some text first.", 400);
    }

    const item = await engine.context.ingestText({ name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : "Pasted text", text: input.text, kind: "markdown", source: { type: "paste" } });
    const session = await engine.context.attach(c.req.param("id"), [item.id]);
    return c.json({ session, item }, 201);
  });

  api.post("/sessions/:id/context/folder", async (c) => {
    const input = await body(c);
    if (typeof input.path !== "string" || input.path.trim() === "") {
      throw new TextoicError("Give the folder path.", 400);
    }

    const collection = await engine.context.ingestFolder(input.path.trim());
    const session = await engine.context.attach(c.req.param("id"), collection.itemIds, `Added folder ${collection.name} (${collection.itemIds.length} files, ${collection.tokens} tokens)`);
    return c.json({ session, collection }, 201);
  });

  api.post("/sessions/:id/context/import", async (c) => {
    const input = await body(c);
    if (typeof input.fromSessionId !== "string") {
      throw new TextoicError("Pick a session to import from.", 400);
    }

    const session = await engine.context.importFromSession(c.req.param("id"), input.fromSessionId, {
      itemIds: Array.isArray(input.itemIds) ? (input.itemIds as string[]) : undefined,
      documents: typeof input.documents === "boolean" ? input.documents : true,
    });
    return c.json({ session });
  });

  api.delete("/sessions/:id/context/:itemId", async (c) => c.json({ session: await engine.context.detach(c.req.param("id"), c.req.param("itemId")) }));

  api.get("/sessions/:id/context/search", async (c) => {
    const hits = await engine.context.search(c.req.param("id"), c.req.query("q") ?? "", Number(c.req.query("limit") ?? 8));
    return c.json({ hits: hits.map((hit) => ({ itemId: hit.item.id, name: hit.item.name, chunkId: hit.chunkId, score: hit.score, excerpt: engine.context.excerpt(hit.text) })) });
  });

  api.get("/context/:itemId", async (c) => {
    const item = await engine.context.get(c.req.param("itemId"));
    return c.json({ item, text: await engine.context.text(item.id) });
  });

  api.get("/sessions/:id/audit", async (c) => {
    const entries = await engine.audit.list(c.req.param("id"), { limit: Number(c.req.query("limit") ?? 100), before: c.req.query("before") });
    return c.json({ entries: entries.map((entry) => ({ ...entry, ai: entry.ai ? { ...entry.ai, calls: entry.ai.calls.map((call) => ({ ...call, messages: [], output: "" })) } : undefined })) });
  });

  api.get("/sessions/:id/audit/:entryId", async (c) => {
    const entry = await engine.audit.get(c.req.param("id"), c.req.param("entryId"));
    if (!entry) {
      throw new TextoicError("No such audit entry.", 404);
    }

    const [before, after] = await Promise.all([entry.before ? engine.audit.snapshot(entry.before) : null, entry.after ? engine.audit.snapshot(entry.after) : null]);
    return c.json({ entry, before, after });
  });

  api.get("/sessions/:id/research", async (c) => c.json({ records: await engine.research.list(c.req.param("id")), hasResearch: await engine.research.hasResearch(c.req.param("id")) }));

  api.get("/sessions/:id/factchecks", async (c) => c.json({ runs: await engine.factcheck.list(c.req.param("id")) }));

  api.get("/sessions/:id/factchecks/:runId", async (c) => {
    const run = await engine.factcheck.get(c.req.param("id"), c.req.param("runId"));
    if (!run) {
      throw new TextoicError("No such fact-check.", 404);
    }

    return c.json({ run });
  });

  api.get("/sessions/:id/novel", async (c) => c.json({ novel: (await engine.sessions.get(c.req.param("id"))).novel ?? null }));

  api.put("/sessions/:id/novel", async (c) => {
    const input = await body(c);
    const session = await engine.sessions.get(c.req.param("id"));
    if (!session.novel) {
      throw new TextoicError("This session is not a novel session.", 400);
    }

    const novel: NovelState = {
      ...session.novel,
      settings: typeof input.settings === "object" && input.settings !== null ? { ...session.novel.settings, ...(input.settings as object) } : session.novel.settings,
      blueprint: typeof input.blueprint === "object" && input.blueprint !== null ? (input.blueprint as NovelState["blueprint"]) : session.novel.blueprint,
      approved: typeof input.approved === "boolean" ? input.approved : session.novel.approved,
    };
    const updated = await engine.sessions.setNovel(session.id, novel, { actor: HUMAN });
    return c.json({ novel: updated.novel });
  });

  api.post("/sessions/:id/actions/:name/estimate", async (c) => {
    const input = await body(c);
    const estimate = await engine.actions.estimate(c.req.param("name"), { sessionId: c.req.param("id"), params: paramsOf(input), choice: providerChoice(input) });
    return c.json({ estimate });
  });

  api.post("/sessions/:id/actions/:name/run", async (c) => {
    const input = await body(c);
    const job = await engine.actions.start(c.req.param("name"), { sessionId: c.req.param("id"), params: paramsOf(input), choice: providerChoice(input) });
    return c.json({ job }, 202);
  });

  api.get("/jobs", (c) => c.json({ jobs: engine.jobs.list(c.req.query("sessionId")) }));

  api.get("/jobs/events", (c) => {
    const sessionId = c.req.query("sessionId");
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = engine.jobs.subscribe((job) => {
        if (!closed && (!sessionId || job.sessionId === sessionId)) {
          void stream.writeSSE({ event: "job", data: JSON.stringify(job) });
        }
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      await stream.writeSSE({ event: "ready", data: "ok" });
      while (!closed) {
        await stream.sleep(15_000);
        if (!closed) {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
      }
    });
  });

  api.get("/jobs/:jobId", (c) => {
    const job = engine.jobs.get(c.req.param("jobId"));
    if (!job) {
      throw new TextoicError("No such job.", 404);
    }

    return c.json({ job });
  });

  api.post("/jobs/:jobId/cancel", (c) => c.json({ cancelled: engine.jobs.cancel(c.req.param("jobId")) }));

  api.post("/lint", async (c) => {
    const input = await body(c);
    return c.json({ issues: await engine.lint.lint(typeof input.text === "string" ? input.text : "") });
  });

  app.route("/api", api);

  if (webDir) {
    app.get("*", async (c) => {
      const requested = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^([/\\])+/u, "");
      const candidate = join(webDir, requested);
      if (!candidate.startsWith(webDir)) {
        return c.notFound();
      }

      const file = (await stat(candidate).catch(() => null))?.isFile() ? candidate : join(webDir, "index.html");
      try {
        const content = await readFile(file);
        return new Response(new Uint8Array(content), {
          status: 200,
          headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" },
        });
      } catch {
        return c.notFound();
      }
    });
  }

  return app;
};
