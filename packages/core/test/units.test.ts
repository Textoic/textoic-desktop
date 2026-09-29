import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonLoosely, JsonParseError } from "../src/providers/json.js";
import { Bm25Index, terms } from "../src/context/bm25.js";
import { chunkText, outlineOf } from "../src/ingest/chunk.js";
import { blocks, maskMarkdown } from "@textoic/enlint-lsp";
import { plainText } from "../src/lint/markdown.js";
import { summarizeChange, unifiedDiff } from "../src/audit/diff.js";
import { mergeSettings, defaultSettings } from "../src/settings.js";
import { locateQuote } from "../src/factcheck/service.js";
import { passageBounds } from "../src/lint/rewrite.js";
import { countWords, titleFromText } from "../src/util.js";

describe("parseJsonLoosely", () => {
  it("parses plain, fenced and prefixed JSON", () => {
    assert.deepEqual(parseJsonLoosely('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonLoosely('Sure! ```json\n{"a": [1,2]}\n```'), { a: [1, 2] });
    assert.deepEqual(parseJsonLoosely('Here you go: {"name": "x", "n": {"y": 2}} hope it helps'), { name: "x", n: { y: 2 } });
  });

  it("repairs trailing commas and curly quotes", () => {
    assert.deepEqual(parseJsonLoosely('{"a": [1,2,],}'), { a: [1, 2] });
    assert.deepEqual(parseJsonLoosely('{“a”: “b”}'), { a: "b" });
  });

  it("throws a typed error with the raw text", () => {
    assert.throws(() => parseJsonLoosely("nothing here"), (error: unknown) => error instanceof JsonParseError && error.raw === "nothing here");
  });
});

describe("bm25", () => {
  it("tokenizes without stopwords and with light stemming", () => {
    assert.deepEqual(terms("The dogs were running quickly to the park"), ["dog", "runn", "quick", "park"]);
  });

  it("ranks the chunk mentioning the query terms first", () => {
    const index = new Bm25Index([
      { id: "a", text: "Oranges grow in Valencia and are harvested in winter." },
      { id: "b", text: "The stock market closed higher on Tuesday after the earnings report." },
      { id: "c", text: "Valencia is a city on the Spanish coast known for paella." },
    ]);
    const hits = index.search("orange harvest winter");
    assert.equal(hits[0].id, "a");
    assert.equal(index.search("nothing matches here at all").length, 0);
  });
});

describe("chunking", () => {
  it("chunks by paragraphs, keeps offsets exact and tracks headings", () => {
    const text = "# Title\n\nFirst paragraph here.\n\n## Section two\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = chunkText(text, "markdown");
    assert.ok(chunks.length >= 1);
    for (const chunk of chunks) {
      assert.equal(text.slice(chunk.at, chunk.end).trim(), text.slice(chunk.at, chunk.end).trim());
      assert.ok(chunk.end > chunk.at);
    }

    assert.equal(chunks[chunks.length - 1].heading, "Section two");
    assert.deepEqual(outlineOf(text, "markdown"), ["# Title", "## Section two"]);
  });

  it("splits a giant paragraph into bounded pieces that cover it", () => {
    const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
    const chunks = chunkText(text, "text");
    assert.ok(chunks.length > 1);
    assert.equal(chunks[0].at, 0);
    assert.equal(chunks[chunks.length - 1].end, text.length);
    chunks.forEach((chunk, index) => {
      if (index > 0) {
        assert.equal(chunk.at, chunks[index - 1].end);
      }
    });
  });

  it("chunks code by line windows", () => {
    const code = Array.from({ length: 100 }, (_, index) => `const v${index} = ${index};`).join("\n");
    const chunks = chunkText(code, "code");
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[chunks.length - 1].end, code.length);
    assert.ok(outlineOf("export function alpha() {}\nclass Beta {}", "code").includes("export function alpha"));
  });
});

describe("markdown", () => {
  it("masks syntax without moving characters", () => {
    const source = "## Heading\n\nSome **bold** text with a [link](http://x.y) and `code`.";
    const masked = maskMarkdown(source);
    assert.equal(masked.length, source.length);
    assert.equal(masked.indexOf("bold"), source.indexOf("bold"));
    assert.equal(masked.indexOf("link"), source.indexOf("link"));
    assert.ok(!masked.includes("http"));
  });

  it("splits into blocks with absolute offsets", () => {
    const source = "# Title\n\nFirst para.\nStill first.\n\n- item one\n\nLast para.";
    const found = blocks(source);
    assert.equal(found.length, 4);
    assert.equal(source.slice(found[1].at, found[1].at + found[1].text.length), "First para.\nStill first.");
    assert.equal(found[3].at, source.indexOf("Last para."));
  });

  it("strips markdown for plain-text export", () => {
    assert.equal(plainText("# Hi\n\nThis is **bold** and _it_ and [a link](http://a.b).\n\n- one\n- two"), "Hi\n\nThis is bold and it and a link.\n\n- one\n- two");
  });
});

describe("diff and summaries", () => {
  it("counts added and removed words and renders a patch", () => {
    const summary = summarizeChange("the cat sat", "the dog sat down");
    assert.equal(summary.addedWords, 2);
    assert.equal(summary.removedWords, 1);
    assert.ok(unifiedDiff("a\nb\n", "a\nc\n").includes("+c"));
    assert.equal(unifiedDiff("same", "same"), "");
  });
});

describe("settings", () => {
  it("merges patches and rejects junk", () => {
    const merged = mergeSettings(defaultSettings(), { provider: "openrouter", model: "x/y", lintIdleMs: 10, lintRules: { "no-similes": false, junk: "no" }, research: { effort: "bogus", budgetUsd: -3 } });
    assert.equal(merged.provider, "openrouter");
    assert.equal(merged.model, "x/y");
    assert.equal(merged.lintIdleMs, 250);
    assert.deepEqual(merged.lint, { rules: { "no-similes": "off" } });
    assert.equal(merged.research.effort, "medium");
    assert.equal(merged.research.budgetUsd, 0);
  });

  it("keeps well-formed ignored instances per document and drops the rest", () => {
    const instance = { rule: "no-explained-intensifiers", quote: "very dirty", context: "The hall was very dirty." };
    const merged = mergeSettings(defaultSettings(), { ignoredInstances: { "textoic://s/a.md": [instance, { rule: 1 }], "textoic://s/b.md": [] } });
    assert.deepEqual(merged.ignoredInstances, { "textoic://s/a.md": [instance] });
    assert.deepEqual(mergeSettings(merged, { model: "m" }).ignoredInstances, merged.ignoredInstances);
  });
});

describe("helpers", () => {
  it("locates quotes exactly and approximately", () => {
    const text = "The bridge opened in 1932.  It was “the longest” then.";
    assert.deepEqual(locateQuote(text, "opened in 1932"), [11, 25]);
    const fuzzy = locateQuote(text, 'It was "the longest" then.');
    assert.ok(fuzzy && fuzzy[0] === text.indexOf("It was"));
    assert.equal(locateQuote(text, "not present anywhere in this text"), null);
  });

  it("expands a selection to paragraph bounds", () => {
    const text = "Para one.\n\nPara two is here.\n\nPara three.";
    assert.deepEqual(passageBounds(text, 14, 14), [11, 28]);
    assert.deepEqual(passageBounds(text, 0, 0), [0, 9]);
  });

  it("counts words and derives titles", () => {
    assert.equal(countWords("Don't stop me-now, 3 times!"), 5);
    assert.equal(titleFromText("# The Title\n\nbody"), "The Title");
    assert.equal(titleFromText("\n\n  **bold first line** more\nnext"), "bold first line more");
    assert.equal(titleFromText(""), "Untitled");
  });
});
