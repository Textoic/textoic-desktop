# Architecture

Read this before changing anything. It records why the system is shaped the way it is, what was tried, and the invariants that span files. Add an entry when you learn something the code cannot say; keep entries short and dated.

## Shape

```
web (React + CodeMirror)  ──HTTP /api──▶  server (Hono)  ──▶  core (Textoic engine)
        │                                   │                     ├── sessions + audit
        └────────WebSocket /lsp─────────────┘                     ├── context engine (store, BM25, digests, explorer, assembler)
                                     enlint-lsp (shared server)     ├── lint (artisan → enlint, via enlint-lsp)
                                                                            ├── actions (runner, jobs, traces)
                                                                            ├── templates (tweet, article, novel)
                                                                            ├── research (budget-researcher adapter)
                                                                            └── fact-check
```

`core` has no HTTP and no UI. `server` is a thin translation of core into routes and sockets. `web` only talks to `server`. A hosted product imports `core` and `server` and supplies its own `Storage` and `ProviderFactory`.

## Decisions

### 2026-09-30 — "Apply all" fixes in the editor, rewrites through the costed job

The exact fixes come from the language server (`enlint/fixAll` over the `/lsp` socket), which already holds the text the editor shows, and go into CodeMirror as one transaction. They save like typing and appear in the audit log as a human edit, because nothing about them is AI. The AI half reuses `lint.rewriteAll` with a `scope` param (`{ rule?, case? }`), so it gets the cost estimate, the job bar's progress ("rewriting part 2 of 5") and the audit trace for free. That action now plans parts of about 500 words with `chunksWithProblems` from enlint-lsp instead of one call per paragraph.

### 2026-09-29 — the issues panel reads LSP diagnostics; ignored instances live in settings

The Issues tab lists style issues from the raw LSP diagnostics (rule, case and fixes ride in `data`), not from the CodeMirror diagnostics, which carry only a message. "In view" means the lines on screen: the editor reports them from `documentTop` and `lineBlockAtHeight` on scroll, resize and view updates, once per animation frame, because `visibleRanges` includes CodeMirror's render margin. "By type" groups with enlint-lsp's `groupedByRule`, largest group first; groups collapse in component state.

"Ignore this one" stores `{ rule, quote, context }` under the document's LSP URI in `settings.ignoredInstances`, in the data folder's settings file. `clientSettingsFrom` passes them to every LSP socket, and `onSettingsChange` re-lints, so the problem disappears everywhere the document is open. `mergeSettings` drops malformed entries and empty lists. Entries for deleted documents stay until someone restores them; they cost a few bytes each. The panel's open state and mode are per-browser conveniences in localStorage.

### 2026-09-29 — "Rewrite all issues" is one audited action with one call per paragraph

`lint.rewriteAll` lints the document once, takes the paragraphs with issues from enlint-lsp's `passagesWithProblems`, and runs the same audited rewrite as `lint.rewrite` on each, one after another, so the cost dialog lists one planned call per paragraph and the audit entry holds every call. The job result keeps every rewrite with its verdict; the dialog ticks the ones that passed, and `POST /documents/:id/rewrite-all` applies the ticked indexes with `withRewrites` in one document update, refusing with 409 if the document changed since the job ran. A server test drives the whole path with a fake provider.

### 2026-09-27 — linting moved to enlint-lsp; the app keeps the audited rewrite

The Textoic family now has three editors (this app, the VS Code extension and textoic.com), and all three need the same linting, config and rewrite prompt. `packages/lsp`, `lint/incremental.ts`, `lint/parser.ts` and the Markdown masking moved to `@textoic/enlint-lsp`; `english-lint` and `nlp` became `@textoic/enlint` and `@textoic/artisan`. `LintService` is now a thin wrapper that resolves `settings.lint` and calls `lintText`.

The rewrite keeps its own action because it must go through `ActionContext` for the cost estimate and the audit trace. It takes the prompt, passage bounds, answer cleaning and the accept/reject verdict from `@textoic/enlint-lsp/rewrite`, so the three editors judge a rewrite the same way.

`settings.lintRules` (rule → boolean) became `settings.lint`, an eslint-style `TextoicConfig` with severities and ignored cases. `mergeSettings` converts a stored `lintRules` on load, so old data directories keep their choices. The LSP socket takes its config from settings rather than from the browser, and `Textoic.onSettingsChange` pushes each change into every open LSP session, which re-lints. The default idle delay dropped from 4,000 to 750 ms to match the other editors.

### 2026-09-08 — every AI action is an `ActionDefinition` with `estimate` and `run`

R4 asks for a cost estimate before any AI action and R2 for an audit of every AI-led change. Both are only reliable if there is one path. `ActionRunner.start` builds the provider, calls `estimate`, creates a `Job`, then runs the action through a `TraceContext` whose `call`/`callJson` record every model call (messages, params, usage, cost, duration, output) into an `AiTrace`. Document writes returned by the action go through `SessionService` with the AI actor and the trace attached, so the audit entry carries the diff and the trace together. Actions that persist their own results (research, fact-check, blueprint) still get an audit entry with the trace.

Consequence: prompts are built by pure functions that both `estimate` and `run` call, so an estimate is the real prompt sized, not a guess. Where a later call depends on an earlier output (part outlines, scenes, judge batches) the estimate uses a fixed placeholder size and says so in `note`.

### 2026-09-08 — the novel pipeline is a port of novelbot, not an import

`novelbot` is a CommonJS-style tsx project with extension-less imports, hardcoded Gemini model names per stage, free-text blueprint sections and its own OpenRouter/Ollama client. Importing it would have bypassed provider choice (R3), cost estimates (R4) and the audit trace (R2), and free-text sections cannot be edited as characters and plot points (R1.2.3). `templates/novel` keeps novelbot's step order (core elements → protagonist → secondary characters → world → framework → parts → part outlines → chapter outline → scenes), its prompt text and its guardrails (name advice, archetypes, scene continuity rules, the 350-word scene retry), but asks for JSON matching zod schemas that mirror novelbot's `schemas.ts`, and renders the current blueprint as Markdown into every later prompt so human edits are what the model builds on.

Chapter outlines (scene level) are not part of the blueprint. novelbot generates them for every chapter up front; here they are produced per chapter when a chapter is written, which keeps the blueprint cost proportional to the plot rather than the length.

`saveNovelProgress` persists after each step without an audit entry so a failed run keeps its progress; the action records one audit entry at the end with the pre-generation snapshot passed explicitly as the diff baseline. Without that baseline the final `setNovel` saw no change, because the last progress save had already stored the final blueprint.

### 2026-09-08 — context is content-addressed and shared across sessions

Consideration 2 (never redo work) drives the storage shape. A `ContextItem` id is the SHA-256 of its text. Ingesting the same file twice, importing a session's documents into another session, or re-indexing a folder all resolve to existing items. Chunks, outlines and per-model digests live on the item, not the session; a session is a list of item ids. Briefs from the explorer are cached under a key derived from the task, the session's item manifest and the model.

### 2026-09-08 — token efficiency is a ladder, cheapest rung first

Consideration 1 (behave like a harness on large corpora) is met by `assembleContext`:

1. If everything fits the budget, send everything in full.
2. Otherwise send small items in full and a card (name, size, outline headings, digest if one exists for this model) for the rest.
3. Fill the remaining budget with BM25 hits for the task query, as excerpts with chunk ids.
4. Optionally prepend a brief produced by the explorer.

BM25 was chosen over embeddings because it needs no model, works offline, is deterministic and is good enough for keyword-shaped retrieval over a writer's reference material; embeddings can be added as a second index without changing the assembler.

The explorer (`context/explorer.ts`) is the harness-like part: a bounded loop (12 steps) where the model chooses `list`, `search`, `read` or `finish` and only reads chunks it asked for. It is an explicit action with its own estimate because on a local model 12 steps is minutes, and its output is cached.

### 2026-09-08 — incremental linting reparses blocks, relints everything

Parsing with `nlp` is the expensive part; `english-lint` over parsed sentences is cheap. `DocumentLinter` splits the text into Markdown-aware blocks (a port of enlint-lab's `blocks`/`mask`, which keep offsets exact), caches the parse per block text, and shifts cached parses to their new offsets. Rules then run over all sentences because `no-negated-contrasts` reads the following sentence and `lint`'s overlap resolution is global. The LSP reports `parsedBlocks`/`reusedBlocks` so the UI can show that only the edited paragraph was re-parsed.

The 4-second idle re-lint lives in the language server, not the client, so any LSP client gets the same behaviour; `textoic/relint` bypasses it.

### 2026-09-08 — research uses budget-researcher through a provider adapter

`ResearchClient` accepts any `InferenceProvider`. Instead of its own Ollama/OpenRouter classes, the research action passes an adapter over the action's `TraceContext`, so every research call is priced with Textoic's pricing (including overrides), counted in the job's spend, and stored in the audit trace. `BudgetGuard` inside the engine still enforces the hard cap. The report is ingested as a `research` context item, which is what fact-checking looks for.

### 2026-09-08 — fact-checking judges only against attached evidence

Claims are extracted per 6,000-character window with the exact quote, located back in the document (exact match, then a whitespace-tolerant prefix match), then judged in batches of six with BM25 evidence per claim. The judge prompt forbids using model memory as evidence; a claim with no retrievable support is `unverifiable`, not `supported`. Findings keep document offsets so the editor can mark them; if the document changes the run is stale and the UI shows it as history.

### 2026-09-08 — human edits coalesce, AI edits never do

The editor saves 1.5 seconds after typing stops. Recording each save would flood the log, so consecutive human `document.edit` entries on the same document within `auditCoalesceMs` (two minutes) are merged into one entry whose diff runs from the first snapshot to the latest. AI entries are never merged; each is one action.

### 2026-09-08 — settings, keys and storage

`Settings` is one JSON document. The OpenRouter and Serper keys are stored in plain text in the self-hosted data directory and redacted in every API response; the UI sends the redacted placeholder back and the engine ignores it. `FileStorage` writes JSON atomically (temp file + rename) and keeps the audit log as JSONL. `MemoryStorage` exists for tests and as the reference for a hosted `Storage` implementation.

## Invariants

- Every offset in a `LintIssue`, `FactFinding` or `Rewrite` indexes the exact document string it was computed from; the server refuses to apply a rewrite whose `documentHash` no longer matches.
- `ContextItem.id === sha256(text)`; a blob with that hash always exists when the item exists.
- Prompts for a template step are built from the persisted blueprint, never from a cached earlier model output.
- `types.ts` has no runtime imports so the browser can import `@textoic/core/types`.

## Things not done yet

- Real tokenizers per model (counts are `chars/4`).
- Running the parser in a worker thread.
- An embeddings index next to BM25.
- Streaming model output into the editor.
- Full-novel generation after the test chapter (novelbot's chapter loop, plot-problem pass and final edit).
