# Working on Textoic

A pnpm monorepo: `packages/core` (engine), `packages/lsp` (language server), `packages/server` (HTTP + WebSocket API and launcher), `packages/web` (React + CodeMirror UI). Read `docs/architecture.md` before changing behaviour and add an entry there when you learn something the code cannot state.

## Conventions

- TypeScript, ESM, strict. Relative imports carry the `.js` extension. `packages/core/src/types.ts` must stay free of runtime imports (the browser imports it).
- Sibling repos are linked, not copied: `../english-lint`, `../nlp`, `../deepresearch` (package `budget-researcher`). Rebuild them in place when their source changes; do not edit them from here.
- Every AI call goes through an `ActionContext` (`call`/`callJson`) so it lands in the audit trace. Do not call providers directly from features.
- Prompts are pure functions used by both `estimate` and `run` of an action.
- Keep functions small and names descriptive; comments are for what a name cannot carry.

## Loop

1. `pnpm build` (core → lsp → server → web).
2. `pnpm test` runs the Node test runner in core, lsp and server. Core tests load the real `nlp` dictionary.
3. `pnpm dev` starts the API with tsx watch; `pnpm dev:web` the Vite dev server on 5173.
4. Summarise what changed, what was verified and how, and what was left undone.
