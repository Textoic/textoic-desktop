import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { MemoryStorage, Textoic } from "@textoic/core";
import { WebSocket } from "ws";
import { attachSockets } from "../src/sockets.js";

type Message = { id?: number; method?: string; params?: { uri?: string; diagnostics?: { code?: string }[] } };

const until = async (check: () => boolean, deadline = Date.now() + 30_000): Promise<void> => {
  if (check()) {
    return;
  }

  if (Date.now() > deadline) {
    throw new Error("timed out");
  }

  await new Promise((resolve) => setTimeout(resolve, 25));
  return until(check, deadline);
};

const listening = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

describe("lsp socket", () => {
  it("lints over the socket and re-lints when the lint settings change", async () => {
    const engine = new Textoic({ storage: new MemoryStorage() });
    const server = createServer();
    const sockets = attachSockets(server, engine);
    const port = await listening(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/lsp`);
    const received: Message[] = [];
    socket.on("message", (data) => received.push(JSON.parse(String(data)) as Message));
    await new Promise((resolve) => socket.once("open", resolve));
    const send = (message: object) => socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));

    send({ id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
    await until(() => received.some((message) => message.id === 1));
    send({ method: "initialized", params: {} });
    const uri = "session://doc";
    send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "markdown", version: 1, text: "The room was very dirty." } } });

    const published = () => received.filter((message) => message.method === "textDocument/publishDiagnostics" && message.params?.uri === uri);
    await until(() => published().length === 1);
    assert.deepEqual(published()[0].params?.diagnostics?.map(({ code }) => code), ["no-explained-intensifiers"]);

    await engine.updateSettings({ lint: { rules: { "no-explained-intensifiers": ["warn", { ignore: ["dirty"] }] } } });
    await until(() => published().length === 2);
    assert.deepEqual(published()[1].params?.diagnostics, []);

    socket.close();
    sockets.close();
    server.close();
  });
});
