# Textoic

Textoic is a writing and editing platform built around a live style linter and heavy, auditable AI assistance. You paste or generate text, the editor shows style problems as you type, and every AI action is estimated before it runs and recorded after it runs with its prompt, parameters, usage, cost and diff.

It runs as a self-hosted app on your machine, and every piece of it is a TypeScript library that a hosted product can import.

## What it does

- **Sessions** group a text (or a chain of texts) with its context, research, fact-checks and audit log. Start blank and paste your own text, or start from a template: **tweet** (one idea, 280 characters), **article** (planned and drafted, 500 to 1,000 words) or **novel** (a structured blueprint you edit and approve, then a test chapter).
- **Live style review** through a Language Server (LSP) wired to `nlp` and `english-lint`. The document is re-linted when you stop typing for four seconds, and only the paragraphs that changed are re-parsed. Quick fixes come from the linter's mechanical suggestions; "Rewrite with AI" hands the flagged passage and the style guide to the model and verifies the result with the linter before offering it.
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
  lsp/     @textoic/lsp    the language server (stdio binary and WebSocket transport)
  server/  @textoic/server HTTP + WebSocket API around core, and the `textoic` launcher
  web/     @textoic/web    the editor UI (React + CodeMirror), served by the launcher
docs/architecture.md       design decisions, trade-offs and what to read before changing things
```

`@textoic/core` depends on three sibling repositories checked out next to this one: `../english-lint`, `../nlp` and `../deepresearch` (package name `budget-researcher`). They are linked, not vendored.

## Running it

Requirements: Node 22+, pnpm 9, the three sibling repos built (`npm run build` in `english-lint` and `nlp`, `pnpm build` in `deepresearch`), and either [Ollama](https://ollama.com) running locally or an OpenRouter key. Research needs a search backend: the SearXNG container from `deepresearch` (`docker compose up -d` there) or a Serper key.

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

Core tests run the real `nlp` parser and `english-lint` rules, and exercise sessions, audit coalescing, the context engine, every action (with a scripted fake provider), the novel pipeline and the fact-checker. The LSP test drives a real language-server connection over streams. The server test hits the HTTP API in-process.

## Using it as a library

```ts
import { createTextoic } from "@textoic/core";
import { createApp, attachSockets } from "@textoic/server";

const engine = createTextoic({ dataDir: "/var/textoic" });   // or storage: yourStorageAdapter
const app = createApp({ engine });                            // a Hono app: mount it under any prefix
```

`Storage` is an interface (`FileStorage` and `MemoryStorage` ship with core); a hosted deployment implements it over its database and keeps the rest. `ProviderFactory` lets the host decide which model a user may run.

## Language server

`packages/lsp/dist/stdio.js` (bin `textoic-lsp`) speaks LSP over stdio for editor plugins. The web UI uses the same server over the `/lsp` WebSocket. Diagnostics carry the rule id as `code` and the mechanical fixes in `data`; `textDocument/codeAction` returns them as quick fixes; `textoic/relint` forces an immediate lint; `textoic/lintStats` reports how many blocks were re-parsed.

## Status and known limits

- Token estimates are character-based placeholders (four characters per token) until per-model tokenizers are wired in; OpenRouter reports the actual cost after each call and that is what the audit log stores.
- The linter runs inside the server process; a very large document blocks the event loop for the parse of the changed paragraphs only, but a first open of a 100k-word text takes a few seconds.
- PDF import is not supported; convert to text or DOCX first.
- The research engine runs sequentially and reports progress as a single step; expect a few minutes per report on a local model.
- The OpenRouter key is stored in plain text in `data/settings.json`.
