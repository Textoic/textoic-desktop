import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage, Textoic } from "@textoic/core";
import { createApp } from "../src/app.js";

const json = async (response: Response) => (await response.json()) as Record<string, never>;

describe("http api", () => {
  it("manages sessions, documents, context and audit over HTTP", async () => {
    const engine = new Textoic({ storage: new MemoryStorage() });
    const app = createApp({ engine });

    const health = await json(await app.request("/api/health"));
    assert.equal(health.ok, true);

    const created = await json(await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Draft" }) }));
    const sessionId = created.session.id as string;
    const documentId = created.documents[0].id as string;

    const edited = await json(await app.request(`/api/sessions/${sessionId}/documents/${documentId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# Hello\n\nThe cake was eaten by the dog." }) }));
    assert.equal(edited.document.wordCount, 8);

    const form = new FormData();
    form.append("file", new File(["Context about cakes and dogs."], "notes.txt", { type: "text/plain" }));
    const uploaded = await json(await app.request(`/api/sessions/${sessionId}/context/upload`, { method: "POST", body: form }));
    assert.equal(uploaded.items.length, 1);

    const context = await json(await app.request(`/api/sessions/${sessionId}/context`));
    assert.equal(context.items.length, 1);

    const search = await json(await app.request(`/api/sessions/${sessionId}/context/search?q=cakes`));
    assert.equal(search.hits.length, 1);

    const audit = await json(await app.request(`/api/sessions/${sessionId}/audit`));
    const actions = (audit.entries as { action: string }[]).map((entry) => entry.action);
    assert.ok(actions.includes("document.edit") && actions.includes("context.add"));

    const exported = await app.request(`/api/sessions/${sessionId}/documents/${documentId}/export?format=text`);
    assert.equal(await exported.text(), "Hello\n\nThe cake was eaten by the dog.");

    const lint = await json(await app.request("/api/lint", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "The cake was eaten by the dog." }) }));
    assert.ok((lint.issues as unknown[]).length > 0);

    const missing = await app.request("/api/sessions/nope");
    assert.equal(missing.status, 404);

    const noModel = await app.request(`/api/sessions/${sessionId}/actions/generate.tweet/estimate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params: { prompt: "hi" } }) });
    assert.equal(noModel.status, 400);
  });
});
