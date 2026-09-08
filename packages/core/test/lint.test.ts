import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocumentLinter, lintOnce } from "../src/lint/incremental.js";
import { loadParser } from "../src/lint/parser.js";
import { configFrom, ruleDefaults } from "../src/lint/service.js";

const PASSIVE = "The report was written by the committee.";

describe("linter", () => {
  it("finds issues at correct absolute offsets inside markdown", async () => {
    const parser = await loadParser();
    const text = `# Heading\n\nIntro paragraph.\n\n${PASSIVE} At the end of the day it was fine.`;
    const issues = lintOnce(parser, text);
    assert.ok(issues.length > 0, "expected the passive and the bad phrase to be flagged");
    for (const issue of issues) {
      assert.ok(issue.end > issue.start);
      assert.ok(issue.start >= text.indexOf(PASSIVE), `issue ${issue.id} should sit in the last paragraph`);
    }

    const filler = issues.find((issue) => text.slice(issue.start, issue.end).toLowerCase().includes("at the end of the day"));
    assert.ok(filler, "no-bad-words should flag the filler phrase");
  });

  it("reparses only the blocks that changed", async () => {
    const parser = await loadParser();
    const linter = new DocumentLinter(parser);
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index} says something plain and short.`);
    const first = linter.lint(paragraphs.join("\n\n"));
    assert.equal(first.parsedBlocks, 6);
    assert.equal(first.reusedBlocks, 0);

    const edited = [...paragraphs];
    edited[3] = `${PASSIVE} And a new sentence.`;
    const second = linter.lint(edited.join("\n\n"));
    assert.equal(second.parsedBlocks, 1);
    assert.equal(second.reusedBlocks, 5);
    const passive = second.issues.find((issue) => issue.id === "no-passive-sentences");
    assert.ok(passive, "the edited paragraph should now carry a passive");
    const joined = edited.join("\n\n");
    assert.ok(passive.start >= joined.indexOf(PASSIVE) && passive.end <= joined.indexOf(PASSIVE) + PASSIVE.length);

    const shifted = [`A brand new first paragraph.`, ...edited];
    const third = linter.lint(shifted.join("\n\n"));
    assert.equal(third.parsedBlocks, 1);
    const moved = third.issues.find((issue) => issue.id === "no-passive-sentences");
    assert.ok(moved);
    assert.equal(moved.start - (passive?.start ?? 0), "A brand new first paragraph.\n\n".length);
  });

  it("respects rule configuration", async () => {
    const parser = await loadParser();
    const off = new DocumentLinter(parser, configFrom({ "no-passive-sentences": false }));
    assert.ok(!off.lint(PASSIVE).issues.some((issue) => issue.id === "no-passive-sentences"));
    assert.equal(ruleDefaults()["no-passive-sentences"], true);
    assert.equal(ruleDefaults()["no-special-punctuation"], false);
  });
});
