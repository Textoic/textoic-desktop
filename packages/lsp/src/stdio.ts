#!/usr/bin/env node
import { LintService, createTextoic } from "@textoic/core";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { attachLanguageServer } from "./server.js";

const engine = createTextoic();
const lint = new LintService(() => engine.settings());
const connection = createConnection(ProposedFeatures.all);
attachLanguageServer(connection, {
  lint,
  idleMs: async () => (await engine.settings()).lintIdleMs,
  log: (message) => connection.console.log(message),
});
connection.listen();
