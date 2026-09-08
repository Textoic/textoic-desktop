export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
  data?: { ruleId: string; fixes: { range: [number, number]; text: string }[] };
}

export interface LintStats {
  uri: string;
  version: number;
  issues: number;
  parsedBlocks: number;
  reusedBlocks: number;
  totalBlocks: number;
  durationMs: number;
}

type Handlers = {
  onDiagnostics: (uri: string, version: number | undefined, diagnostics: LspDiagnostic[]) => void;
  onStats?: (stats: LintStats) => void;
  onState?: (state: "connecting" | "open" | "closed") => void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class LspClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers: Handlers;
  private readonly open = new Map<string, { version: number; text: string; languageId: string }>();
  private closed = false;
  private ready: Promise<void> = Promise.resolve();
  private reconnectTimer: number | null = null;

  constructor(handlers: Handlers) {
    this.handlers = handlers;
    this.connect();
  }

  private connect() {
    this.handlers.onState?.("connecting");
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/lsp`);
    this.socket = socket;
    this.ready = new Promise<void>((resolve) => {
      socket.addEventListener("open", async () => {
        await this.request("initialize", { processId: null, rootUri: null, capabilities: {} });
        this.notify("initialized", {});
        for (const [uri, document] of this.open) {
          this.notify("textDocument/didOpen", { textDocument: { uri, languageId: document.languageId, version: document.version, text: document.text } });
        }

        this.handlers.onState?.("open");
        resolve();
      });
    });
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => {
      this.handlers.onState?.("closed");
      for (const pending of this.pending.values()) {
        pending.reject(new Error("LSP connection closed"));
      }

      this.pending.clear();
      if (!this.closed) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 2000);
      }
    });
  }

  private receive(raw: string) {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending?.reject(new Error(message.error.message));
      } else {
        pending?.resolve(message.result);
      }

      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] };
      this.handlers.onDiagnostics(params.uri, params.version, params.diagnostics);
    } else if (message.method === "textoic/lintStats") {
      this.handlers.onStats?.(message.params as LintStats);
    } else if (message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async openDocument(uri: string, text: string, languageId = "markdown") {
    const version = (this.open.get(uri)?.version ?? 0) + 1;
    this.open.set(uri, { version, text, languageId });
    await this.ready;
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
  }

  changeDocument(uri: string, text: string) {
    const current = this.open.get(uri);
    if (!current) {
      return;
    }

    const version = current.version + 1;
    this.open.set(uri, { ...current, version, text });
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  closeDocument(uri: string) {
    if (this.open.delete(uri)) {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
  }

  relint(uri: string) {
    return this.request<{ ok: boolean; issues?: number }>("textoic/relint", { uri });
  }

  dispose() {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }

    this.socket?.close();
  }
}
