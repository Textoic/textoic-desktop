import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage, Textoic } from "@textoic/core";
import { createApp } from "../src/app.js";

type Request = { messages: { role: string; content: string }[] };

const fixes = (request: Request) =>
  (request.messages.at(-1)?.content ?? "").includes("written") ? "The committee wrote the report." : "The room was filthy.";

const provider = {
  kind: "openrouter" as const,
  model: "fake/model",
  complete: async (request: Request) => ({ content: fixes(request), usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001, model: "fake/model", provider: "openrouter" as const, finishReason: "stop", truncated: false }),
  listModels: async () => [{ id: "fake/model", name: "fake/model", provider: "openrouter" as const, pricing: { prompt: 0.000001, completion: 0.000002 } }],
  pricing: async () => ({ prompt: 0.000001, completion: 0.000002 }),
};

const finished = async (engine: Textoic, jobId: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = engine.jobs.get(jobId);
    if (job && job.status !== "queued" && job.status !== "running") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("the job did not finish");
};

describe("rewrite all issues", () => {
  it("estimates one call per paragraph, proposes rewrites and applies the chosen ones", async () => {
    const engine = new Textoic({ storage: new MemoryStorage(), dataDir: "data-test", providerFactory: () => provider as never });
    const app = createApp({ engine });
    const session = await engine.sessions.create({ title: "Draft" });
    const documentId = session.documentIds[0];
    const text = "The room was very dirty.\n\nThis is fine.\n\nThe report was written by the committee.";
    await engine.sessions.updateDocument(session.id, documentId, { content: text }, { actor: { kind: "human" }, action: "document.edit", summary: "typed" });

    const estimate = await engine.actions.estimate("lint.rewriteAll", { sessionId: session.id, params: { documentId } });
    assert.equal(estimate.calls, 2);

    const job = await engine.actions.start("lint.rewriteAll", { sessionId: session.id, params: { documentId } });
    const done = await finished(engine, job.id);
    assert.equal(done.status, "done", done.error);
    const rewrites = (done.result as { rewriteAll: { rewrites: { replacement: string; accepted: boolean }[] } }).rewriteAll.rewrites;
    assert.deepEqual(rewrites.map(({ replacement, accepted }) => [replacement, accepted]), [
      ["The room was filthy.", true],
      ["The committee wrote the report.", true],
    ]);

    const applied = await app.request(`/api/sessions/${session.id}/documents/${documentId}/rewrite-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id, indexes: [1] }) });
    assert.equal(applied.status, 200);
    const document = await engine.sessions.getDocument(session.id, documentId);
    assert.equal(document.content, "The room was very dirty.\n\nThis is fine.\n\nThe committee wrote the report.");

    const again = await app.request(`/api/sessions/${session.id}/documents/${documentId}/rewrite-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id, indexes: [0] }) });
    assert.equal(again.status, 409);
  });
});
