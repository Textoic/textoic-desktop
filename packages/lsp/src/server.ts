import type { LintService } from "@textoic/core";
import type { Diagnostic } from "vscode-languageserver/node";
import {
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type InitializeResult,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { codeActionsFor, toDiagnostic } from "./diagnostics.js";

export interface LanguageServerOptions {
  lint: LintService;
  idleMs?: () => Promise<number> | number;
  log?: (message: string) => void;
}

export const RELINT_REQUEST = "textoic/relint";
export const LINT_STATS_NOTIFICATION = "textoic/lintStats";

export interface LintStats {
  uri: string;
  version: number;
  issues: number;
  parsedBlocks: number;
  reusedBlocks: number;
  totalBlocks: number;
  durationMs: number;
}

export const attachLanguageServer = (connection: Connection, options: LanguageServerOptions) => {
  const documents = new TextDocuments(TextDocument);
  const timers = new Map<string, NodeJS.Timeout>();
  const published = new Map<string, Diagnostic[]>();
  const inFlight = new Map<string, Promise<void>>();
  const log = options.log ?? (() => undefined);

  const lintNow = async (document: TextDocument): Promise<void> => {
    const pending = inFlight.get(document.uri);
    if (pending) {
      await pending;
    }

    const run = (async () => {
      const version = document.version;
      const started = Date.now();
      try {
        const result = await options.lint.lintIncremental(document.uri, document.getText());
        const current = documents.get(document.uri);
        if (!current || current.version !== version) {
          return;
        }

        const diagnostics = result.issues.map((issue) => toDiagnostic(current, issue));
        published.set(document.uri, diagnostics);
        await connection.sendDiagnostics({ uri: document.uri, version, diagnostics });
        const stats: LintStats = {
          uri: document.uri,
          version,
          issues: diagnostics.length,
          parsedBlocks: result.parsedBlocks,
          reusedBlocks: result.reusedBlocks,
          totalBlocks: result.totalBlocks,
          durationMs: Date.now() - started,
        };
        await connection.sendNotification(LINT_STATS_NOTIFICATION, stats);
      } catch (cause) {
        log(`lint failed for ${document.uri}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    })();
    inFlight.set(document.uri, run);
    await run;
    if (inFlight.get(document.uri) === run) {
      inFlight.delete(document.uri);
    }
  };

  const schedule = async (document: TextDocument) => {
    const existing = timers.get(document.uri);
    if (existing) {
      clearTimeout(existing);
    }

    const idle = await options.idleMs?.();
    const timer = setTimeout(() => {
      timers.delete(document.uri);
      void lintNow(document);
    }, idle ?? 4000);
    timers.set(document.uri, timer);
  };

  connection.onInitialize((): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      codeActionProvider: { codeActionKinds: ["quickfix"] },
    },
    serverInfo: { name: "textoic-lsp", version: "0.1.0" },
  }));

  const openedAt = new Map<string, number>();

  documents.onDidOpen((event) => {
    openedAt.set(event.document.uri, event.document.version);
    void lintNow(event.document);
  });

  documents.onDidChangeContent((event) => {
    if (openedAt.get(event.document.uri) === event.document.version) {
      return;
    }

    void schedule(event.document);
  });

  documents.onDidClose((event) => {
    const timer = timers.get(event.document.uri);
    if (timer) {
      clearTimeout(timer);
      timers.delete(event.document.uri);
    }

    published.delete(event.document.uri);
    options.lint.release(event.document.uri);
    void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onCodeAction((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return [];
    }

    return codeActionsFor(document, published.get(document.uri) ?? [], params.range);
  });

  connection.onRequest(RELINT_REQUEST, async (params: { uri: string }) => {
    const document = documents.get(params.uri);
    if (!document) {
      return { ok: false };
    }

    const timer = timers.get(document.uri);
    if (timer) {
      clearTimeout(timer);
      timers.delete(document.uri);
    }

    await lintNow(document);
    return { ok: true, issues: published.get(document.uri)?.length ?? 0 };
  });

  documents.listen(connection);
  return { documents, lintNow };
};
