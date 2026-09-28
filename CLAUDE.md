# Working on Textoic Desktop

A pnpm monorepo: `packages/core` (engine), `packages/server` (HTTP + WebSocket API, the LSP socket and the launcher), `packages/web` (React + CodeMirror UI). The language server itself is `@textoic/enlint-lsp`, shared with the VS Code extension and textoic.com. Read `docs/architecture.md` before changing behaviour and add an entry there when you learn something the code cannot state.

## Conventions

- TypeScript, ESM, strict. Relative imports carry the `.js` extension. `packages/core/src/types.ts` must stay free of runtime imports (the browser imports it).
- Sibling repos are linked, not copied: `../enlint`, `../enlint-lsp`, `../deepresearch` (package `budget-researcher`). Rebuild them in place when their source changes; do not edit them from here. Linting, rule config and the rewrite prompt live in `enlint-lsp`; change them there so every client gets the change.
- Every AI call goes through an `ActionContext` (`call`/`callJson`) so it lands in the audit trace. Do not call providers directly from features.
- Prompts are pure functions used by both `estimate` and `run` of an action.
- Keep functions small and names descriptive; comments are for what a name cannot carry.

## Loop

1. `pnpm build` (core → server → web).
2. `pnpm test` runs the Node test runner in core and server. Core tests load the real `artisan` dictionary.
3. `pnpm dev` starts the API with tsx watch; `pnpm dev:web` the Vite dev server on 5173.
4. Summarise what changed, what was verified and how, and what was left undone.
