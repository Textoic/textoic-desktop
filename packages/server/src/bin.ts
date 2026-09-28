#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTextoic } from "@textoic/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { attachSockets } from "./sockets.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`textoic [--port 4747] [--host 127.0.0.1] [--data ./data] [--web <dir>]

  --port  Port to listen on (default 4747, or PORT)
  --host  Interface to bind (default 127.0.0.1, or HOST)
  --data  Data directory for sessions, context and settings (default ./data, or TEXTOIC_DATA)
  --web   Directory with the built web UI (default: the bundled @textoic/web build)`);
  process.exit(0);
}

const port = Number(option("port", process.env.PORT ?? "4747"));
const host = option("host", process.env.HOST ?? "127.0.0.1");
const dataDir = option("data", process.env.TEXTOIC_DATA ?? "data");
const bundledWeb = fileURLToPath(new URL("../../web/dist", import.meta.url));
const webDir = option("web", bundledWeb);

const engine = createTextoic({ dataDir });
const app = createApp({ engine, webDir: existsSync(webDir) ? webDir : undefined });

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Textoic listening on http://${info.address === "::" ? "localhost" : info.address}:${info.port}`);
  console.log(`Data directory: ${engine.dataDir}`);
  if (!existsSync(webDir)) {
    console.log(`No web build found at ${webDir}; only the API and LSP are served. Run "pnpm build" to build the UI.`);
  }
});

attachSockets(server as import("node:http").Server, engine, (message) => console.log(`[lsp] ${message}`));

void engine.lint.ready().then(() => console.log("Style linter ready (artisan dictionary loaded)."));

const shutdown = () => {
  server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
