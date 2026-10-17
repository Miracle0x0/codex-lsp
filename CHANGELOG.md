# Changelog

## Unreleased

- Stop publishing to npm: remove the `publish` workflow and its registry token. The repository root is now a local marketplace (`.agents/plugins/marketplace.json`, `codex-lsp-local`) that lists the staged plugin.
- Consolidate the Codex adapter and LSP runtime into one pnpm package: `src/codex/` and `src/core/`, with one executable, lockfile, build, and test configuration.
- Package the core directly with production dependencies; include usage and design documentation, and verify the plugin outside the source tree without symlinks or a separately published runtime.
- Build with TypeScript 7 and run real TypeScript 6 and TypeScript 7 native LSP/compiler tests, alongside Pyright, Ruff, gopls, clangd, and rust-analyzer.
- Preserve complete edit/rename diagnostic baselines, retain old baselines for unconfirmed results, and recheck every open related file.
- Re-evaluate background progress after timeouts; report incomplete tracking even with no file changes, and distinguish atomic replacements from new files.
- Capture current shell configuration and extra variables at every prompt, report capture failures, and provide explicit `env list` / `env remove` snapshot management.
- Sign call hierarchy handles and bind them to server instances, configurations, environment generations, and file contents; emit requested MCP start/completion notifications.
- Keep the Codex compatibility plugin layout and `2026-07-28` MCP revision, including native PreToolUse/PostToolUse hooks and a manually enabled authenticated Codex CI contract.

## 0.2.0

- Extracted the LSP runtime and MCP server into [`@code-yeongyu/lsp-tools-mcp`](https://github.com/code-yeongyu/lsp-tools-mcp).
- codex-lsp now consumes that runtime as a git submodule at `packages/lsp-tools-mcp`.
- Kept the Codex-specific PostToolUse hook in this package and routed MCP serving through the upstream CLI.

- Extract LSP runtime to `lsp-tools-mcp` upstream and consume it via git submodule at `packages/lsp-tools-mcp`.
- Renamed the MCP server namespace to `lsp` and exposed shorter tool names such as `lsp.diagnostics`.
- Use portable Codex hook interpolation and add package smoke coverage for hook/MCP entrypoints.
- Spawn language servers without shell mode; Windows `.cmd` and `.bat` shims are routed through `cmd.exe` with explicit arguments.
- Cap directory diagnostics file traversal and run CI on Windows in addition to Ubuntu and macOS.
- Replace the external JSON-RPC runtime dependency with an internal LSP framing layer so clean Codex plugin installs run without `node_modules`.

## 0.1.0

- Ported the standalone LSP client, server resolution, diagnostics aggregation, and workspace edit runtime from `pi-lsp-client`.
- Added Codex `PostToolUse` diagnostics for edit-style tools.
- Added MCP tools for status, diagnostics, definitions, references, symbols, prepare rename, and rename.
- Added Codex plugin metadata, skill docs, CI, and release automation.
