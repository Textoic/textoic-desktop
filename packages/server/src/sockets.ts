import type { Server } from "node:http";
import { LintService, type Textoic } from "@textoic/core";
import { attachLanguageServer, connectionOverWebSocket } from "@textoic/lsp";
import { WebSocketServer } from "ws";

export const attachSockets = (server: Server, engine: Textoic, log: (message: string) => void = () => undefined) => {
  const lsp = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/lsp") {
      socket.destroy();
      return;
    }

    lsp.handleUpgrade(request, socket, head, (client) => {
      const lint = new LintService(() => engine.settings());
      const connection = connectionOverWebSocket(client);
      attachLanguageServer(connection, { lint, idleMs: async () => (await engine.settings()).lintIdleMs, log });
      connection.listen();
      client.on("close", () => connection.dispose());
      log("LSP client connected");
    });
  });

  return { close: () => lsp.close() };
};
