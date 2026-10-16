# Changelog

## Unreleased

- Development and CI use a pnpm workspace that includes the `lsp-tools-mcp` submodule through `workspace:*`.
- The plugin uses the Codex compat layout (`.codex-plugin/plugin.json` + `.mcp.json`) and is staged by `pnpm run test:package` with a hoisted, link-free `node_modules`.
- The MCP entry is the root CLI; it serves the `2026-07-28` MCP revision and reads the workspace from Codex turn metadata.
- Picks up the runtime's config schema v1, multi-source diagnostics, and shell-environment binding; `pnpm run test:integration` runs the real-language-server suite.
- Adds `lsp.hover`, `lsp.goto_implementation`, and call hierarchy tools (`lsp.prepare_call_hierarchy`, `lsp.incoming_calls`, `lsp.outgoing_calls`); TypeScript navigation no longer returns single-file results while the project loads.
- `pnpm run test:package` builds both packages before staging so the artifact never ships a stale runtime.
- Post-edit diagnostics run inside the long-lived MCP process through native `mcp_tool` hooks (`pre_edit_snapshot` on PreToolUse, `post_edit_diagnostics` on PostToolUse) for `apply_patch` and `Bash`, replacing the `hook post-tool-use` command that started language servers per edit.
- apply_patch Add/Update/Delete/Move are all handled; shell edits come from a workspace file-change journal; results are diffed against a per-session baseline (new, resolved, first check) and reported as `additionalContext` without blocking the edit.
- Errors and warnings are reported by default; provider failures are always reported.
- The MCP process binds the launcher's environment from `CODEX_LSP_CONTEXT_ID` / `CODEX_LSP_ENV_MANIFEST` (validated; the manifest path names the state directory).
- `test/codex-contract.test.ts` (`CODEX_LSP_CONTRACT=1`) checks the hook contract and the launcher in real Codex sessions.
- `codex-lsp launch` captures the shell's environment and starts `codex --no-daemon` bound to it; `codex-lsp env shell-init bash|zsh|pwsh` keeps a per-shell snapshot current at each prompt; `codex-lsp env capture --kind command` snapshots a command's environment for `environmentId`; `codex-lsp config mcp` prints reviewable config for use without the plugin.
- The `hook post-tool-use` command and its fixtures are removed; the README's `install-local.mjs` instructions are replaced by the verified `codex plugin marketplace add` / `codex plugin add` flow.
- CI installs zsh for the shell integration tests; pwsh is tested on the CI runners.

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
