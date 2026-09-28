import type { Server } from "node:http";
import { parser, type Settings, type Textoic } from "@textoic/core";
import { attachLanguageServer, type ClientSettings } from "@textoic/enlint-lsp";
import { WebSocketServer } from "ws";
import { connectionOverWebSocket } from "./websocket.js";

export const clientSettingsFrom = (settings: Settings): ClientSettings => ({
  config: settings.lint,
  debounceMs: settings.lintIdleMs,
  rewrite: false,
});

export const attachSockets = (server: Server, engine: Textoic, log: (message: string) => void = () => undefined) => {
  const lsp = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/lsp") {
      socket.destroy();
      return;
    }

    lsp.handleUpgrade(request, socket, head, async (client) => {
      const connection = connectionOverWebSocket(client);
      const workspace = attachLanguageServer(connection, { parser });
      workspace.settings = clientSettingsFrom(await engine.settings());
      const stopListening = engine.onSettingsChange((settings) => {
        workspace.settings = clientSettingsFrom(settings);
        workspace.relintAll();
      });
      connection.listen();
      client.on("close", () => {
        stopListening();
        connection.dispose();
      });
      log("LSP client connected");
    });
  });

  return { close: () => lsp.close() };
};
