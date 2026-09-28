# Textoic Desktop

Textoic Desktop is a writing and editing app built around a live style linter and heavy, auditable AI assistance. You paste or generate text, the editor shows style problems as you type, and every AI action is estimated before it runs and recorded after it runs with its prompt, parameters, usage, cost and diff.

It runs as a self-hosted app on your machine, and every piece of it is a TypeScript library that a hosted product can import.

## What it does

- **Sessions** group a text (or a chain of texts) with its context, research, fact-checks and audit log. Start blank and paste your own text, or start from a template: **tweet** (one idea, 280 characters), **article** (planned and drafted, 500 to 1,000 words) or **novel** (a structured blueprint you edit and approve, then a test chapter).
- **Live style review** through [enlint-lsp](https://github.com/Textoic/enlint-lsp), the language server shared with the VS Code extension and textoic.com, running [enlint](https://github.com/Textoic/enlint) over [artisan](https://github.com/Textoic/artisan) parses. The document is re-linted when you stop typing (750 ms by default), and only the paragraphs that changed are re-parsed. Quick fixes come from the linter's mechanical suggestions; "Rewrite with AI" hands the flagged passage and the style guide to the model and verifies the result with the linter before offering it.
- **Your rules**: Settings lists every rule with a description and examples. Set each one's severity, or turn it off. For the rules built from lists of cases (bad words, "very X", "not X") you can ignore single cases, from the settings or straight from a flagged word's tooltip, so "very dirty" stops suggesting "filthy" without losing the rest of the rule.
- **Context** for the model: upload files (`.md`, `.txt`, `.docx`, `.html`, code, data), paste text, index a whole folder or codebase, or import another session's context and documents. Everything is content-addressed, chunked and indexed once; sessions only hold references, so moving context between sessions costs nothing.
- **Deep research** through the sibling `budget-researcher` engine (the `deepresearch` repo): pick the topic, a hard inference budget, the depth (low, medium, high) and the model, and the cited report becomes a context item.
- **Fact-check**: claims are extracted from the document, evidence is retrieved from the session context, and each claim comes back supported, contradicted or unverifiable with the evidence that decided it, marked in the editor.
- **Providers**: local Ollama or remote OpenRouter (with your saved key), with the available models listed in a dropdown and per-model pricing pulled from OpenRouter.
- **Cost before you commit**: every AI action shows the estimated calls, tokens and dollars first. Placeholder token counting is four characters per token; you can override prices per model in settings.
- **Audit log** per session: human edits (coalesced within two minutes), AI edits with the full trace, blueprint edits, context changes. Diffs are stored as unified patches with both snapshots kept.
- **Export** as Markdown, plain text (Markdown stripped) or copy to the clipboard.

## Layout

```
packages/
  core/    @textoic/core   the engine: sessions, audit, providers, context engine, lint, templates, research, fact-check
  server/  @textoic/server HTTP API around core, the /lsp WebSocket (enlint-lsp), and the `textoic` launcher
  web/     @textoic/web    the editor UI (React + CodeMirror), served by the launcher
docs/architecture.md       design decisions, trade-offs and what to read before changing things
```

`@textoic/core` takes the linter from npm (`@textoic/enlint`, `@textoic/enlint-lsp`) and links one sibling checkout: `../deepresearch` (package name `budget-researcher`), which is not public yet. Clone it next to this repository and run `pnpm build` there first.

## Running it

Requirements: Node 22+, pnpm 9, `../deepresearch` built (`pnpm build` there), and either [Ollama](https://ollama.com) running locally or an OpenRouter key. Research needs a search backend: the SearXNG container from `deepresearch` (`docker compose up -d` there) or a Serper key.

```sh
pnpm install
pnpm build
pnpm start            # http://127.0.0.1:4747, data in ./data
```

Flags: `--port`, `--host`, `--data <dir>`, `--web <dir>`. Environment: `PORT`, `HOST`, `TEXTOIC_DATA`.

For development run the API with `pnpm dev` (tsx watch, port 4747) and the UI with `pnpm dev:web` (Vite on port 5173 proxying `/api` and `/lsp`).

Open Settings first: pick the provider and model. Ollama models are listed from the local daemon; OpenRouter models from its catalogue once the key is saved.

## Tests

```sh
pnpm test
```

Core tests run the real `artisan` parser and `enlint` rules, and exercise sessions, audit coalescing, the context engine, every action (with a scripted fake provider), the novel pipeline and the fact-checker. The server tests hit the HTTP API in-process and drive the `/lsp` socket, including a settings change that re-lints an open document. The language server's own tests live in `enlint-lsp`.

## Using it as a library

```ts
import { createTextoic } from "@textoic/core";
import { createApp, attachSockets } from "@textoic/server";

const engine = createTextoic({ dataDir: "/var/textoic" });   // or storage: yourStorageAdapter
const app = createApp({ engine });                            // a Hono app: mount it under any prefix
```

`Storage` is an interface (`FileStorage` and `MemoryStorage` ship with core); a hosted deployment implements it over its database and keeps the rest. `ProviderFactory` lets the host decide which model a user may run.

## Language server

The server package hosts `@textoic/enlint-lsp` on the `/lsp` WebSocket and feeds it the lint config from settings; a settings change re-lints every open document. Diagnostics carry the rule id as `code` and `data: { rule, case?, fixes }`. The same server runs over stdio for editors (`npx enlint-lsp --stdio`); see its README for the protocol and the `textoic.config.json` format.

## Status and known limits

- Token estimates are character-based placeholders (four characters per token) until per-model tokenizers are wired in; OpenRouter reports the actual cost after each call and that is what the audit log stores.
- The linter runs inside the server process; a very large document blocks the event loop for the parse of the changed paragraphs only, but a first open of a 100k-word text takes a few seconds.
- PDF import is not supported; convert to text or DOCX first.
- The research engine runs sequentially and reports progress as a single step; expect a few minutes per report on a local model.
- The OpenRouter key is stored in plain text in `data/settings.json`.
