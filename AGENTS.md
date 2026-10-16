# Repository Conventions

Conventions for humans and agents working on this repository.

## Style

- TypeScript strict mode. No `any`, `@ts-ignore`, `@ts-expect-error`, or enums.
- ESM modules with `.js` suffix in import paths.
- Tabs for indentation. Double quotes for strings.
- Runtime is Node only.
- Tests use vitest and should exercise Codex hook/MCP behavior before implementation changes.

## Commands

- `git submodule update --init --recursive` checks out the `lsp-tools-mcp` runtime.
- `pnpm install --frozen-lockfile` installs the workspace (root + runtime submodule).
- `pnpm run build:all` builds the runtime and the Codex adapter in dependency order.
- `pnpm run check:all` runs typecheck and Biome in both packages.
- `pnpm run test:all` runs both test suites once.
- `pnpm run test:package` stages the plugin with `pnpm deploy` (hoisted, no symlinks) and starts it outside the source tree.

## LSP Constraints

- LSP server processes are owned by `LspManager`.
- Tool execution acquires clients through `withLspClient(...)` unless it only reports static status.
- `lsp.rename` mutates files by applying workspace edits; keep it sequential at the MCP caller level.
- Do not add pi-coding-agent or omo source dependencies. This package is standalone.
