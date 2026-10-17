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
- `pnpm test` runs the logic and component suites (`test/core/`, `test/codex/`). They need Node and the locked dev dependencies only; a global setup rebuilds `dist/` unless `dist/build-info.json` matches the current sources.
- `pnpm run test:platform` runs real shells (bash/zsh on POSIX, pwsh everywhere), file watching, signals, and process trees. Cases that do not apply to the OS are skipped by name.
- `pnpm run test:integration` runs real Pyright, Ruff, uv, Conda, TypeScript 6 via typescript-language-server, TypeScript 7 native LSP/compiler, gopls, clangd, and rust-analyzer. TypeScript SDKs are pinned dev dependencies; the Conda cases create their own temporary environments (network on first use).
- Suites that need external tools use `describeWithTools` (`test/support/tools.ts`): a missing tool skips the suite and prints why; `CODEX_LSP_REQUIRE_TOOLS=1` (set in CI) makes it a failure.
- `pnpm run test:perf` prints diagnostics timings; durations are reported, never asserted.
- `pnpm run test:package` builds and stages a self-contained plugin, installs its production dependencies with pnpm (hoisted, no symlinks), and starts it outside the source tree. `.agents/plugins/marketplace.json` lists that staged directory as the local marketplace `codex-lsp-local`; the package is not published to npm.
- `pnpm run test:contract` drives real Codex in a temporary `CODEX_HOME` (needs network, Codex auth, python3, and Pyright; run `test:package` first, set `CODEX_LSP_CONTRACT_KEEP=1` to keep the files). It is never part of `pnpm test`.

## Source Layout

- `src/cli.ts` is the only executable entry and composes the core and Codex adapter.
- `src/core/` owns MCP/LSP, configuration, diagnostics, documents, edits, and environment snapshots. It must not import the Codex adapter.
- `src/codex/` owns Codex metadata, hooks, shell capture, launch, and config output.
- Tests are layered: `test/core/` and `test/codex/` (default), `test/platform/`, `test/integration/`, `test/contract/`, `test/perf/`, each with its own Vitest config. `test/support/` holds shared fixtures: `isolatedContext` gives every scenario a private home, state directory, and configuration, so a developer's config, activated environments, or Codex login cannot change results.
- `typescript` is the TypeScript 7 compiler and native LSP used by integration tests; `typescript6` is a development-only test SDK for the TypeScript 6 server. Neither is bundled into the plugin.

## LSP Constraints

- LSP server processes are owned by `LspManager`.
- Tool execution acquires clients through `LspManager.withClient(...)` (usually via `LspRuntime.withSemantic` or the diagnostics service) unless it only reports static status.
- `lsp.rename` mutates files by applying workspace edits; keep it sequential at the MCP caller level.
- Do not add pi-coding-agent or omo source dependencies. This package is standalone.
