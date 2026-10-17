# Repository Conventions

Conventions for humans and agents working on this repository.

## Style

- TypeScript strict mode. No `any`, `@ts-ignore`, `@ts-expect-error`, or enums.
- ESM modules with `.js` suffix in import paths.
- Tabs for indentation. Double quotes for strings.
- Runtime is Node only.
- Tests use vitest and should exercise Codex hook/MCP behavior before implementation changes.
- Hooks are `mcp_tool` handlers on the bare server name `lsp`; hook endpoints return Codex hook output JSON as their text content and never throw.
- Shell integration lives in `shell/` as per-shell templates; it must keep existing prompt hooks and the last exit status.
- User-facing usage documentation lives in `docs/`; the README links to it and keeps only an overview. Update the matching guide when behaviour, tools, or configuration change.

## Commands

- `pnpm install --frozen-lockfile` installs this single package from the root lockfile.
- `pnpm run build` cleans `dist/` and builds `src/cli.ts`, `src/codex/`, and `src/core/` with TypeScript 7.
- `pnpm run check` runs typecheck and Biome.
- `pnpm test` runs the core and Codex adapter suites once.
- `pnpm run test:integration` runs real Pyright, Ruff, TypeScript 6 via typescript-language-server, TypeScript 7 native LSP/compiler, gopls, clangd, and rust-analyzer. Required servers must be present; TypeScript SDKs are pinned dev dependencies.
- `pnpm run test:package` builds and stages a self-contained plugin, installs its production dependencies with pnpm (hoisted, no symlinks), and starts it outside the source tree. `.agents/plugins/marketplace.json` lists that staged directory as the local marketplace `codex-lsp-local`; the package is not published to npm.
- `CODEX_LSP_CONTRACT=1 pnpm run test:contract` drives real Codex in a temporary `CODEX_HOME` (needs network and Codex auth; run `test:package` first, set `CODEX_LSP_CONTRACT_KEEP=1` to keep the files).

## Source Layout

- `src/cli.ts` is the only executable entry and composes the core and Codex adapter.
- `src/core/` owns MCP/LSP, configuration, diagnostics, documents, edits, and environment snapshots. It must not import the Codex adapter.
- `src/codex/` owns Codex metadata, hooks, shell capture, launch, and config output.
- `test/core/`, `test/codex/`, and `test/integration/` keep unit/host and real-server coverage separate.
- `typescript` is the TypeScript 7 compiler and native LSP used by integration tests; `typescript6` is a development-only test SDK for the TypeScript 6 server. Neither is bundled into the plugin.

## LSP Constraints

- LSP server processes are owned by `LspManager`.
- Tool execution acquires clients through `LspManager.withClient(...)` (usually via `LspRuntime.withSemantic` or the diagnostics service) unless it only reports static status.
- `lsp.rename` mutates files by applying workspace edits; keep it sequential at the MCP caller level.
- Do not add pi-coding-agent or omo source dependencies. This package is standalone.
