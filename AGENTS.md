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

- `git submodule update --init --recursive` checks out the `lsp-tools-mcp` runtime.
- `pnpm install --frozen-lockfile` installs the workspace (root + runtime submodule).
- `pnpm run build:all` builds the runtime and the Codex adapter in dependency order.
- `pnpm run check:all` runs typecheck and Biome in both packages.
- `pnpm run test:all` runs both test suites once.
- `pnpm run test:integration` runs the runtime against real language servers (Pyright, Ruff, typescript-language-server, gopls, clangd, rust-analyzer); a missing server fails the run.
- `pnpm run test:package` builds both packages, stages the plugin with `pnpm deploy` (hoisted, no symlinks), and starts it outside the source tree.
- `CODEX_LSP_CONTRACT=1 pnpm exec vitest --run test/codex-contract.test.ts` drives real Codex in a temporary `CODEX_HOME` (needs network and Codex auth; run `test:package` first, set `CODEX_LSP_CONTRACT_KEEP=1` to keep the files).

## LSP Constraints

- LSP server processes are owned by `LspManager`.
- Tool execution acquires clients through `LspManager.withClient(...)` (usually via `LspRuntime.withSemantic` or the diagnostics service) unless it only reports static status.
- `lsp.rename` mutates files by applying workspace edits; keep it sequential at the MCP caller level.
- Do not add pi-coding-agent or omo source dependencies. This package is standalone.
