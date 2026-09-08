import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleContext } from "../src/context/assemble.js";
import { FakeProvider, engineWith, lastUserMessage, waitForJob } from "./helpers.js";

describe("sessions and audit", () => {
  it("creates a session with a document and records coalesced human edits", async () => {
    const engine = engineWith(new FakeProvider(() => ""));
    const session = await engine.sessions.create({ title: "Notes" });
    assert.equal(session.documentIds.length, 1);
    const documentId = session.documentIds[0];
    await engine.sessions.updateDocument(session.id, documentId, { content: "Hello world." }, { actor: { kind: "human" } });
    await engine.sessions.updateDocument(session.id, documentId, { content: "Hello there world." }, { actor: { kind: "human" } });
    const entries = await engine.audit.list(session.id);
    const edits = entries.filter((entry) => entry.action === "document.edit");
    assert.equal(edits.length, 1, "consecutive human edits coalesce into one entry");
    assert.ok(edits[0].diff?.includes("+Hello there world."));
    assert.equal(await engine.audit.snapshot(edits[0].before as string), "");
    assert.equal(await engine.audit.snapshot(edits[0].after as string), "Hello there world.");
    assert.equal(await engine.sessions.exportDocument(session.id, documentId, "text"), "Hello there world.");
  });
});

describe("context engine", () => {
  it("deduplicates by content, imports across sessions and searches", async () => {
    const engine = engineWith(new FakeProvider(() => ""));
    const one = await engine.sessions.create({ title: "One" });
    const two = await engine.sessions.create({ title: "Two" });
    const item = await engine.context.ingestText({ name: "facts.md", text: "# Facts\n\nThe Eiffel Tower is 330 metres tall.\n\nIt opened in 1889.", kind: "markdown", source: { type: "paste" } });
    const again = await engine.context.ingestText({ name: "copy.md", text: "# Facts\n\nThe Eiffel Tower is 330 metres tall.\n\nIt opened in 1889.", kind: "markdown", source: { type: "paste" } });
    assert.equal(again.id, item.id, "same content maps to the same item");
    await engine.context.attach(one.id, [item.id]);
    await engine.sessions.updateDocument(one.id, one.documentIds[0], { content: "Paris hosts the tower." }, { actor: { kind: "human" } });
    await engine.context.importFromSession(two.id, one.id);
    const items = await engine.context.itemsFor(two.id);
    assert.equal(items.length, 2, "the item and the other session's document are imported");
    const hits = await engine.context.search(two.id, "how tall is the Eiffel tower");
    assert.equal(hits[0].item.id, item.id);
    assert.ok(hits[0].text.includes("330"));
    const assembled = await assembleContext(engine.context, { sessionId: two.id, query: "tower", budgetTokens: 5000, model: "m" });
    assert.equal(assembled.used.length, 2);
    assert.ok(assembled.used.every((used) => used.mode === "full"));
    const tight = await assembleContext(engine.context, { sessionId: two.id, query: "tower height", budgetTokens: 30, model: "m" });
    assert.ok(tight.tokens <= 60);
  });

  it("ingests uploads and converts html", async () => {
    const engine = engineWith(new FakeProvider(() => ""));
    const item = await engine.context.ingestUpload("page.html", new TextEncoder().encode("<h1>Title</h1><p>Body <b>bold</b>.</p><script>alert(1)</script>"));
    const text = await engine.context.text(item.id);
    assert.ok(text.startsWith("# Title"));
    assert.ok(!text.includes("alert"));
    assert.equal(item.kind, "markdown");
  });
});

describe("actions", () => {
  it("estimates, runs a tweet job, writes the document and audits the trace", async () => {
    const provider = new FakeProvider(() => "A short tweet with one idea and nothing else.");
    const engine = engineWith(provider);
    const session = await engine.sessions.create({ template: "tweet", templateSettings: { prompt: "the joy of linting" } });
    const estimate = await engine.actions.estimate("generate.tweet", { sessionId: session.id, params: { prompt: "the joy of linting" } });
    assert.equal(estimate.calls, 1);
    assert.ok(estimate.usd > 0);
    assert.equal(estimate.known, true);

    const job = await engine.actions.start("generate.tweet", { sessionId: session.id, params: { prompt: "the joy of linting", documentId: session.documentIds[0] } });
    const finished = await waitForJob(engine, job.id);
    assert.equal(finished.status, "done", finished.error);
    const document = await engine.sessions.getDocument(session.id, session.documentIds[0]);
    assert.equal(document.content, "A short tweet with one idea and nothing else.");
    const entries = await engine.audit.list(session.id);
    const aiEntry = entries.find((entry) => entry.actor.kind === "ai");
    assert.ok(aiEntry, "an AI audit entry exists");
    assert.equal(aiEntry.ai?.calls.length, 1);
    assert.ok((aiEntry.ai?.totalUsd ?? 0) > 0);
    assert.ok(aiEntry.diff?.includes("+A short tweet"));
    assert.ok(aiEntry.ai?.calls[0].messages.some((message) => message.content.includes("the joy of linting")));
  });

  it("shortens tweets over the limit", async () => {
    const long = "x".repeat(300);
    const provider = new FakeProvider((_request, calls) => (calls === 1 ? long : "short enough"));
    const engine = engineWith(provider);
    const session = await engine.sessions.create({ template: "tweet" });
    const job = await engine.actions.start("generate.tweet", { sessionId: session.id, params: { prompt: "anything" } });
    const finished = await waitForJob(engine, job.id);
    assert.equal(finished.status, "done");
    assert.equal((finished.result as { text: string }).text, "short enough");
    assert.equal(provider.requests.length, 2);
  });

  it("drafts an article within the word range using a plan", async () => {
    const body = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
    const provider = new FakeProvider((request) =>
      request.json ? JSON.stringify({ title: "Why Lint", sections: [{ heading: "Reasons", points: ["a", "b"], words: 500 }] }) : `# Why Lint\n\n## Reasons\n\n${body}\n\n${body}\n\n${body}\n\n${body}\n\n${body}`,
    );
    const engine = engineWith(provider);
    const session = await engine.sessions.create({ template: "article" });
    const job = await engine.actions.start("generate.article", { sessionId: session.id, params: { prompt: "why lint", minWords: 500, maxWords: 700, documentId: session.documentIds[0] } });
    const finished = await waitForJob(engine, job.id);
    assert.equal(finished.status, "done", finished.error);
    assert.equal(provider.requests.length, 2, "plan + draft, no resize when the draft fits");
    const document = await engine.sessions.getDocument(session.id, session.documentIds[0]);
    assert.equal(document.title, "Why Lint");
    assert.ok(document.wordCount >= 500);
  });

  it("passes attached context into generation prompts", async () => {
    const provider = new FakeProvider(() => "tweet");
    const engine = engineWith(provider);
    const session = await engine.sessions.create({ template: "tweet" });
    const item = await engine.context.ingestText({ name: "brief.txt", text: "Our product is called Zebrafish and launches in May.", kind: "text", source: { type: "paste" } });
    await engine.context.attach(session.id, [item.id]);
    const job = await engine.actions.start("generate.tweet", { sessionId: session.id, params: { prompt: "announce the launch" } });
    await waitForJob(engine, job.id);
    assert.ok(lastUserMessage(provider.requests[0]).includes("Zebrafish"));
  });

  it("marks a failed job and records the failure with its trace", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("boom");
    });
    const engine = engineWith(provider);
    const session = await engine.sessions.create({ template: "tweet" });
    const job = await engine.actions.start("generate.tweet", { sessionId: session.id, params: { prompt: "x" } });
    const finished = await waitForJob(engine, job.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.error, "boom");
  });

  it("rejects prompts over 2000 characters", async () => {
    const engine = engineWith(new FakeProvider(() => "x"));
    const session = await engine.sessions.create({ template: "tweet" });
    await assert.rejects(engine.actions.estimate("generate.tweet", { sessionId: session.id, params: { prompt: "y".repeat(2001) } }), /2000/u);
  });
});

describe("digest and explorer", () => {
  it("digests items once per model and caches briefs by task and manifest", async () => {
    let digests = 0;
    const provider = new FakeProvider((request) => {
      const user = lastUserMessage(request);
      if (user.startsWith("Document")) {
        digests += 1;
        return "A card.";
      }

      if (request.json) {
        return JSON.stringify({ action: "finish", brief: "The corpus says X [facts.md]." });
      }

      return "";
    });
    const engine = engineWith(provider);
    const session = await engine.sessions.create();
    const item = await engine.context.ingestText({ name: "facts.md", text: "Some facts about X that matter.", kind: "markdown", source: { type: "paste" } });
    await engine.context.attach(session.id, [item.id]);
    const first = await waitForJob(engine, (await engine.actions.start("context.digest", { sessionId: session.id })).id);
    assert.equal(first.status, "done", first.error);
    const second = await waitForJob(engine, (await engine.actions.start("context.digest", { sessionId: session.id })).id);
    assert.equal(second.status, "done");
    assert.equal(digests, 1, "the second run reuses the cached digest");
    assert.equal((await engine.context.get(item.id)).digests["fake/model"].text, "A card.");

    const explored = await waitForJob(engine, (await engine.actions.start("context.explore", { sessionId: session.id, params: { task: "write about X" } })).id);
    assert.equal(explored.status, "done", explored.error);
    assert.equal((explored.result as { cached: boolean }).cached, false);
    const again = await waitForJob(engine, (await engine.actions.start("context.explore", { sessionId: session.id, params: { task: "write about X" } })).id);
    assert.equal((again.result as { cached: boolean }).cached, true);
  });
});

describe("fact-check", () => {
  it("extracts claims, retrieves evidence and stores verdicts with offsets", async () => {
    const provider = new FakeProvider((request) => {
      const user = lastUserMessage(request);
      if (user.startsWith("Passage:")) {
        return JSON.stringify({ claims: [{ claim: "The tower is 330 metres tall", quote: "The tower stands 330 metres tall." }, { claim: "It opened in 1900", quote: "It opened in 1900." }] });
      }

      return JSON.stringify({ verdicts: [{ id: "k1", verdict: "supported", confidence: 0.9, explanation: "matches", evidence: [] }, { id: "k2", verdict: "contradicted", confidence: 0.8, explanation: "opened in 1889", evidence: [] }] });
    });
    const engine = engineWith(provider);
    const session = await engine.sessions.create();
    const text = "The tower stands 330 metres tall. It opened in 1900.";
    await engine.sessions.updateDocument(session.id, session.documentIds[0], { content: text }, { actor: { kind: "human" } });
    const research = await engine.context.ingestText({ name: "Research: tower", text: "The Eiffel Tower is 330 metres tall and opened in 1889.", kind: "research", source: { type: "research", runId: "r", topic: "tower" } });
    await engine.context.attach(session.id, [research.id]);
    assert.equal(await engine.research.hasResearch(session.id), true);
    const job = await engine.actions.start("factcheck.run", { sessionId: session.id, params: { documentId: session.documentIds[0] } });
    const finished = await waitForJob(engine, job.id);
    assert.equal(finished.status, "done", finished.error);
    const runs = await engine.factcheck.list(session.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].findings.length, 2);
    const contradicted = runs[0].findings.find((finding) => finding.verdict === "contradicted");
    assert.ok(contradicted);
    assert.equal(text.slice(contradicted.start, contradicted.end), "It opened in 1900.");
    assert.ok(contradicted.evidence.length > 0, "evidence from the research item is attached");
  });
});
