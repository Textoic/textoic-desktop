import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReviewFindings,
  reviewEditLoop,
  reviewFindingsFrom,
  type BlueprintFinding,
} from "../src/templates/novel/review-loop.js";
import { reviewPromptBlueprint } from "../src/templates/novel/review.js";
import {
  blueprintStringPaths,
  blueprintReviewMessages,
} from "../src/templates/novel/review.js";
import { TraceContext } from "../src/actions/context.js";
import {
  FakeProvider,
  engineWith,
  lastUserMessage,
  waitForJob,
} from "./helpers.js";
import type { CoreStoryElements, NovelSettings } from "../src/types.js";

const finding = (
  before: string,
  after: string | null,
  path = ["synopsis"],
): BlueprintFinding => ({
  path,
  before,
  after,
  reason: "The witness is alive in the ending.",
  references: ["ending"],
});

test("review prompts enumerate canonical editable paths rather than invented nesting", () => {
  const blueprint = {
    characters: [{ id: "stable", name: "Ada", arc: "Returns" }],
    protagonist: { name: "Ensemble" },
  } as never;
  const paths = blueprintStringPaths(blueprint);
  assert.ok(paths.some((p) => p.join(".") === "characters.0.arc"));
  assert.ok(!paths.some((p) => p.at(-1) === "id"));
  const content = blueprintReviewMessages(
    blueprint,
    "context",
    (p) => p[0] === "characters",
  )[1].content;
  const listed = content
    .split("Editable paths:\n")[1]
    .split("\n\nAuthoritative")[0];
  assert.ok(listed.includes('"characters"'));
  assert.ok(!listed.includes('"protagonist"'));
});
const options = {
  initial: { synopsis: "dead", title: "Keep me" },
  canEdit: (path: string[]) => path[0] === "synopsis",
  validate: () => undefined,
};

test("applies only suggested edits, checks the edited candidate and records rounds", async () => {
  const seen: string[] = [];
  const result = await reviewEditLoop({
    ...options,
    review: async (value) => {
      seen.push(value.synopsis);
      return value.synopsis === "dead" ? [finding("dead", "alive")] : [];
    },
  });
  assert.deepEqual(seen, ["dead", "alive"]);
  assert.deepEqual(result.value, { synopsis: "alive", title: "Keep me" });
  assert.equal(result.report.status, "passed");
  assert.deepEqual(
    result.report.rounds.map((r) => r.applied),
    [true, false],
  );
});

test("leaves final review suggestions unapplied when the edit budget is spent", async () => {
  const result = await reviewEditLoop({
    ...options,
    maxEdits: 1,
    review: async (value) => [finding(value.synopsis, `${value.synopsis}!`)],
  });
  assert.equal(result.value.synopsis, "dead!");
  assert.equal(result.report.stopReason, "limit");
  assert.equal(result.report.rounds.length, 2);
  assert.equal(result.report.status, "needs-review");
});

test("stops oscillation and preserves the last validated candidate", async () => {
  const result = await reviewEditLoop({
    ...options,
    review: async (value) => [
      finding(value.synopsis, value.synopsis === "dead" ? "alive" : "dead"),
    ],
  });
  assert.equal(result.value.synopsis, "alive");
  assert.equal(result.report.stopReason, "cycle");
});

test("rejects an entire invalid edit round without changing the input", async () => {
  const result = await reviewEditLoop({
    ...options,
    review: async () => [
      finding("dead", "alive"),
      finding("Keep me", "lost", ["title"]),
    ],
  });
  assert.deepEqual(result.value, options.initial);
  assert.equal(result.report.stopReason, "blocked");
  assert.match(result.report.rounds[0].error ?? "", /cannot edit/u);
  assert.equal(options.initial.synopsis, "dead");
});

test("retains the previous candidate when deterministic validation rejects an edit", async () => {
  const result = await reviewEditLoop({
    ...options,
    review: async () => [finding("dead", "copied source")],
    validate: () => {
      throw new Error("Copied source");
    },
  });
  assert.equal(result.value.synopsis, "dead");
  assert.match(result.report.rounds[0].error ?? "", /Copied source/u);
});

test("requires exact anchors, unique paths, real string fields and immutable IDs", () => {
  for (const fs of [
    [finding("stale", "alive")],
    [finding("dead", "alive"), finding("alive", "again")],
    [finding("", "created", ["absent"])],
    [finding("id1", "id2", ["id"])],
    [finding("", "bad", ["constructor", "prototype", "polluted"])],
  ]) {
    assert.throws(() =>
      applyReviewFindings({ synopsis: "dead", id: "id1" }, fs, () => true),
    );
  }
  assert.throws(() =>
    reviewFindingsFrom({
      findings: [{ ...finding("dead", "alive"), references: [] }],
    }),
  );
});

test("unfixable findings and cancellation do not silently pass", async () => {
  const blocked = await reviewEditLoop({
    ...options,
    review: async () => [finding("dead", null)],
  });
  assert.equal(blocked.report.status, "needs-review");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reviewEditLoop({
      ...options,
      signal: controller.signal,
      review: async () => [],
    }),
    /abort/iu,
  );
});

const settings: NovelSettings = {
  prompt: "Keep the witness alive.",
  genre: "mystery",
  wordCount: 20000,
  nsfw: false,
};
const core: CoreStoryElements = {
  tone: "quiet",
  genres: ["mystery"],
  structure: "investigation",
  keyStages: [],
  coreTheme: "memory",
  emotionalJourney: "trust",
  initialSynopsis: "The witness dies.",
  worldRules: [],
};

test("prompt blueprint actions review edits and persist their findings for the client", async () => {
  const provider = new FakeProvider((request) => {
    const text = lastUserMessage(request);
    if (!text.includes("Candidate blueprint:")) return JSON.stringify(core);
    const candidate = JSON.parse(text.split("Candidate blueprint:\n")[1]) as {
      coreElements: CoreStoryElements;
    };
    return JSON.stringify({
      findings:
        candidate.coreElements.initialSynopsis === "The witness dies."
          ? [
              finding("The witness dies.", "The witness survives.", [
                "coreElements",
                "initialSynopsis",
              ]),
            ]
          : [],
    });
  });
  const engine = engineWith(provider);
  const session = await engine.sessions.create({
    template: "novel",
    templateSettings: settings,
  });
  const estimate = await engine.actions.estimate("novel.blueprint", {
    sessionId: session.id,
    params: { steps: ["coreElements"] },
  });
  assert.ok(JSON.stringify(estimate).includes("blueprint:review"));
  const job = await waitForJob(
    engine,
    (
      await engine.actions.start("novel.blueprint", {
        sessionId: session.id,
        params: { steps: ["coreElements"] },
      })
    ).id,
  );
  assert.equal(job.status, "done", job.error);
  const novel = (await engine.sessions.get(session.id)).novel!;
  assert.equal(
    novel.blueprint.coreElements?.initialSynopsis,
    "The witness survives.",
  );
  assert.equal(novel.blueprintReview?.status, "passed");
  assert.equal(novel.approved, false);
  const edited = await engine.sessions.setNovel(
    session.id,
    {
      ...novel,
      blueprint: {
        ...novel.blueprint,
        coreElements: { ...core, tone: "human edit" },
      },
    },
    { actor: { kind: "human" } },
  );
  assert.equal(edited.novel?.blueprintReview, undefined);
});

test("prompt review protects sections outside the selected generation scope", async () => {
  const provider = new FakeProvider(() =>
    JSON.stringify({
      findings: [finding("Human title", "LLM title", ["framework", "title"])],
    }),
  );
  const engine = engineWith(provider);
  const ctx = new TraceContext({ provider, settings: await engine.settings() });
  const framework = {
    title: "Human title",
    hook: "",
    ignitionPoint: "",
    plotPoints: [],
    climax: "",
    resolution: "",
    characterTransformation: "",
  };
  const result = await reviewPromptBlueprint(ctx, {
    settings,
    initial: { framework },
    blueprint: { framework, coreElements: core },
    steps: ["coreElements"],
  });
  assert.equal(result.value.framework?.title, "Human title");
  assert.equal(result.report.status, "needs-review");
});
