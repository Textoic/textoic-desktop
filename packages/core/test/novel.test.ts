import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBlueprint } from "../src/templates/novel/render.js";
import { remainingSteps } from "../src/templates/novel/blueprint.js";
import type { NovelSettings } from "../src/types.js";
import { FakeProvider, engineWith, lastUserMessage, waitForJob } from "./helpers.js";

const settings: NovelSettings = { prompt: "A lighthouse keeper discovers the sea is a machine.", wordCount: 30000, genre: "science fiction", nsfw: false };

const answers: Record<string, unknown> = {
  "fundamental elements": { tone: "eerie", genres: ["science fiction"], structure: "Rebirth", keyStages: ["a", "b", "c"], coreTheme: "control", emotionalJourney: "from denial to acceptance", initialSynopsis: "Para one.\n\nPara two.", worldRules: [] },
  "protagonist profile": { name: "Maren Holt", age: "41", physicalDescription: "weathered", traits: ["conscientious"], flaw: "believes control is possible", desires: ["safety"], fears: ["the dark"], background: "grew up inland", arc: "learns to let go" },
  "secondary characters": { characters: [{ name: "Tomas Reyes", role: "Ally", relationship: "supply boat pilot", physicalDescription: "tall", motivation: "curiosity", conflict: "wants to leave", arc: "stays" }] },
  "world-building guide": { primaryLocations: ["the lighthouse"], timeframe: "one winter", atmosphere: "damp", naturalLaws: [], supernaturalElements: [], consequences: ["the sea stops"], powerStructures: "the coastguard", conflicts: "isolation", symbols: ["the lamp"] },
  "structural framework": { title: "The Tide Engine", hook: "a wave freezes mid-air", ignitionPoint: "the sea skips a beat", plotPoints: [{ name: "P1", description: "d", wordCountLocation: 3000, characterImpact: "i" }], climax: "c", resolution: "r", characterTransformation: "t" },
  "story outline": { parts: [{ title: "Part One", synopsis: "Things happen.", wordCount: 15000 }, { title: "Part Two", synopsis: "More things.", wordCount: 15000 }] },
  "detailed breakdown of Part": { chapters: [{ title: "The Frozen Wave", synopsis: "Maren sees the wave.", wordCount: 2000, nsfw: false }, { title: "Tomas Arrives", synopsis: "The boat comes.", wordCount: 2000, nsfw: false }] },
  "detailed breakdown of Chapter": { scenes: [{ wordCount: 600, synopsis: "Maren climbs the stairs and sees the wave stop.", nsfw: false }, { wordCount: 600, synopsis: "She radios the coastguard.", nsfw: false }] },
};

const scene = Array.from({ length: 420 }, (_, index) => `word${index}`).join(" ");

const script = (request: { messages: { role: string; content: string }[]; json?: unknown }) => {
  const user = lastUserMessage(request as never);
  const key = Object.keys(answers).find((phrase) => user.includes(phrase));
  if (key) {
    return JSON.stringify(answers[key]);
  }

  if (user.includes("writing a single scene")) {
    return scene;
  }

  throw new Error(`Unexpected prompt: ${user.slice(0, 80)}`);
};

describe("novel template", () => {
  it("generates the blueprint step by step, keeps edits, and writes a test chapter", async () => {
    const provider = new FakeProvider(script);
    const engine = engineWith(provider);
    const session = await engine.sessions.create({ template: "novel", templateSettings: settings });
    assert.ok(session.novel);
    assert.equal(session.documentIds.length, 0);
    assert.deepEqual(remainingSteps(session.novel.blueprint).length, 7);

    const first = await waitForJob(engine, (await engine.actions.start("novel.blueprint", { sessionId: session.id, params: { steps: ["coreElements", "protagonist"] } })).id);
    assert.equal(first.status, "done", first.error);
    let novel = (await engine.sessions.get(session.id)).novel;
    assert.equal(novel?.blueprint.protagonist?.name, "Maren Holt");
    assert.equal(remainingSteps(novel?.blueprint ?? {}).length, 5);

    await engine.sessions.setNovel(session.id, { ...(novel as NonNullable<typeof novel>), blueprint: { ...novel?.blueprint, protagonist: { ...(novel?.blueprint.protagonist as NonNullable<typeof novel>["blueprint"]["protagonist"] & object), name: "Maren Voss" } } }, { actor: { kind: "human" } });

    const rest = await waitForJob(engine, (await engine.actions.start("novel.blueprint", { sessionId: session.id })).id);
    assert.equal(rest.status, "done", rest.error);
    novel = (await engine.sessions.get(session.id)).novel;
    assert.equal(remainingSteps(novel?.blueprint ?? {}).length, 0);
    assert.equal(novel?.blueprint.partOutlines?.length, 2);
    assert.equal(novel?.blueprint.characters?.[0].name, "Tomas Reyes");
    assert.ok(novel?.blueprint.characters?.[0].id);
    const laterPrompt = lastUserMessage(provider.requests[provider.requests.length - 1]);
    assert.ok(laterPrompt.includes("Maren Voss"), "later steps see the human-edited blueprint");

    const rendered = renderBlueprint(novel?.blueprint ?? {}, settings);
    assert.ok(rendered.includes("## Protagonist") && rendered.includes("The Tide Engine"));

    const entries = await engine.audit.list(session.id);
    const blueprintEdits = entries.filter((entry) => entry.target?.type === "blueprint");
    assert.ok(blueprintEdits.some((entry) => entry.actor.kind === "human" && entry.diff?.includes("+Name: Maren Voss")));
    assert.ok(blueprintEdits.some((entry) => entry.actor.kind === "ai" && (entry.ai?.calls.length ?? 0) > 0));

    const chapter = await waitForJob(engine, (await engine.actions.start("novel.testChapter", { sessionId: session.id })).id);
    assert.equal(chapter.status, "done", chapter.error);
    const updated = await engine.sessions.get(session.id);
    assert.equal(updated.documentIds.length, 1);
    const document = await engine.sessions.getDocument(session.id, updated.documentIds[0]);
    assert.equal(document.title, "Chapter 1: The Frozen Wave");
    assert.ok(document.content.startsWith("# The Tide Engine\n\n## Chapter 1: The Frozen Wave"));
    assert.equal(updated.novel?.testChapter?.outline.scenes.length, 2);
  });

  it("refuses the test chapter before the blueprint is complete", async () => {
    const engine = engineWith(new FakeProvider(script));
    const session = await engine.sessions.create({ template: "novel", templateSettings: settings });
    await assert.rejects(engine.actions.estimate("novel.testChapter", { sessionId: session.id }), /Finish the blueprint/u);
  });
});
