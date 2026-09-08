import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import { LintService, MemoryStorage, Textoic } from "@textoic/core";
import {
  createConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type Diagnostic,
  type PublishDiagnosticsParams,
} from "vscode-languageserver/node";
import { createMessageConnection } from "vscode-jsonrpc/node";
import { attachLanguageServer, LINT_STATS_NOTIFICATION, RELINT_REQUEST, type LintStats } from "../src/server.js";

const pair = () => {
  const up = new PassThrough();
  const down = new PassThrough();
  const server = createConnection(new StreamMessageReader(up), new StreamMessageWriter(down));
  const client = createMessageConnection(new StreamMessageReader(down), new StreamMessageWriter(up));
  return { server, client };
};

const PASSIVE = "The report was written by the committee.";

describe("language server", () => {
  it("publishes diagnostics with fixes on open and re-lints after the idle delay", async () => {
    const engine = new Textoic({ storage: new MemoryStorage() });
    await engine.updateSettings({ lintIdleMs: 250 });
    const lint = new LintService(() => engine.settings());
    const { server, client } = pair();
    attachLanguageServer(server, { lint, idleMs: async () => (await engine.settings()).lintIdleMs });
    server.listen();

    const diagnostics: PublishDiagnosticsParams[] = [];
    const stats: LintStats[] = [];
    client.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => diagnostics.push(params));
    client.onNotification(LINT_STATS_NOTIFICATION, (params: LintStats) => stats.push(params));
    client.listen();

    await client.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });
    await client.sendNotification("initialized", {});
    const uri = "file:///doc.md";
    const text = `# Title\n\nPlain sentence here.\n\n${PASSIVE}`;
    await client.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "markdown", version: 1, text } });

    const until = async (check: () => boolean, timeoutMs = 10_000) => {
      const started = Date.now();
      while (!check()) {
        if (Date.now() - started > timeoutMs) {
          throw new Error("timed out");
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    await until(() => diagnostics.length === 1);
    const passive = diagnostics[0].diagnostics.find((diagnostic: Diagnostic) => diagnostic.code === "no-passive-sentences");
    assert.ok(passive, "the passive sentence is reported");
    assert.equal(passive.range.start.line, 4);
    assert.equal(passive.source, "textoic");

    const actions = await client.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: passive.range,
      context: { diagnostics: [passive] },
    });
    assert.ok(Array.isArray(actions) && actions.length > 0, "a quick fix is offered for the passive");

    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 4, character: 0 }, end: { line: 4, character: PASSIVE.length } }, text: "The committee wrote the report." }],
    });
    await until(() => diagnostics.length === 2);
    assert.equal(diagnostics[1].version, 2);
    assert.ok(!diagnostics[1].diagnostics.some((diagnostic: Diagnostic) => diagnostic.code === "no-passive-sentences"));
    assert.equal(stats[1].parsedBlocks, 1, "only the edited block is re-parsed");
    assert.equal(stats[1].reusedBlocks, 2);

    const relint = await client.sendRequest(RELINT_REQUEST, { uri });
    assert.deepEqual(relint, { ok: true, issues: diagnostics[1].diagnostics.length });
    client.dispose();
    server.dispose();
  });
});
