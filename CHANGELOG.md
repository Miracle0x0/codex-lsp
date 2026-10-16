# Changelog

## Unreleased

- Development and CI use a pnpm workspace that includes the `lsp-tools-mcp` submodule through `workspace:*`.
- The plugin uses the Codex compat layout (`.codex-plugin/plugin.json` + `.mcp.json`) and is staged by `pnpm run test:package` with a hoisted, link-free `node_modules`.
- The MCP entry is the root CLI; it serves the `2026-07-28` MCP revision and reads the workspace from Codex turn metadata.
- Picks up the runtime's config schema v1, multi-source diagnostics, and shell-environment binding; `pnpm run test:integration` runs the real-language-server suite.
- Adds `lsp.hover`, `lsp.goto_implementation`, and call hierarchy tools (`lsp.prepare_call_hierarchy`, `lsp.incoming_calls`, `lsp.outgoing_calls`); TypeScript navigation no longer returns single-file results while the project loads.
- `pnpm run test:package` builds both packages before staging so the artifact never ships a stale runtime.

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
