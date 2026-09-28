import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultSettings, mergeSettings } from "../src/settings.js";
import { LintService, ruleDefaults } from "../src/lint/service.js";
import type { Settings } from "../src/types.js";

const PASSIVE = "The report was written by the committee.";

const serviceWith = (patch: Record<string, unknown> = {}) => {
  const settings: Settings = mergeSettings(defaultSettings(), patch);
  return new LintService(() => Promise.resolve(settings));
};

describe("linter", () => {
  it("finds issues at correct absolute offsets inside markdown", async () => {
    const text = `# Heading\n\nIntro paragraph.\n\n${PASSIVE} At the end of the day it was fine.`;
    const issues = await serviceWith().lint(text);
    assert.ok(issues.length > 0, "expected the passive and the bad phrase to be flagged");
    for (const issue of issues) {
      assert.ok(issue.end > issue.start);
      assert.ok(issue.start >= text.indexOf(PASSIVE), `issue ${issue.id} should sit in the last paragraph`);
    }

    const filler = issues.find((issue) => text.slice(issue.start, issue.end).toLowerCase().includes("at the end of the day"));
    assert.ok(filler, "no-bad-words should flag the filler phrase");
    assert.equal(filler.case, "at the end of the day");
  });

  it("respects rule configuration and ignored cases", async () => {
    const off = serviceWith({ lint: { rules: { "no-passive-sentences": "off" } } });
    assert.ok(!(await off.lint(PASSIVE)).some((issue) => issue.id === "no-passive-sentences"));
    const ignored = serviceWith({ lint: { rules: { "no-explained-intensifiers": ["warn", { ignore: ["dirty"] }] } } });
    assert.deepEqual(await ignored.lint("The room was very dirty."), []);
    assert.equal(ruleDefaults()["no-passive-sentences"], true);
    assert.equal(ruleDefaults()["no-special-punctuation"], false);
  });

  it("reads settings saved before the lint config existed", async () => {
    const legacy = serviceWith({ lintRules: { "no-passive-sentences": false } });
    assert.ok(!(await legacy.lint(PASSIVE)).some((issue) => issue.id === "no-passive-sentences"));
  });
});
