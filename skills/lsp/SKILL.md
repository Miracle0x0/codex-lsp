---
name: lsp
description: Use when Codex needs language-server diagnostics, definitions, implementations, references, hover types, call hierarchy, symbols, or rename safety checks in the current workspace.
---

# Codex LSP

Call `lsp` MCP tools through the tool interface; `lsp.*`/`mcp__lsp__*` are tool-call names, not shell commands.

Positions are a 1-based `line` and a 0-based `character` counted in Unicode code points.

## Tools

- `lsp.status`: show configured, installed, missing, disabled, and active language servers; with `filePath`, the toolchain and the exact server backend and command that file gets.
- `lsp.diagnostics`: check one file or directory for LSP diagnostics. When an explicit diagnostics request is needed, prefer `severity: "error"` unless the task requires warnings or lower-severity diagnostics.
- `lsp.goto_definition`: locate a symbol definition from file, line, and character.
- `lsp.goto_implementation`: find implementations of an interface, abstract member, or type.
- `lsp.find_references`: find usages of a symbol across the workspace.
- `lsp.hover`: read the type and documentation of the symbol at a position.
- `lsp.symbols`: inspect document symbols or search workspace symbols.
- `lsp.prepare_call_hierarchy`: resolve the function at a position; pass an item's `handle` unchanged to `lsp.incoming_calls` (callers) or `lsp.outgoing_calls` (callees), and repeat with returned handles to walk deeper.
- `lsp.prepare_rename`: check whether a rename is valid at a position.
- `lsp.rename`: apply a language-server workspace edit for a rename.

## After Edits

The plugin's hooks check every `apply_patch` and shell command automatically and add new, resolved, or unattributed problems to the conversation. Do not call `lsp.diagnostics` after each edit to confirm what the hook already covered, and never call `pre_edit_snapshot` or `post_edit_diagnostics` yourself.

Call `lsp.diagnostics` explicitly when:

- the user asks for a check;
- files or directories the edit did not touch need checking, or a complete diagnostics list is needed;
- information or hint diagnostics are needed;
- hook feedback reports a failed, incomplete, or unconfirmed check;
- the environment or LSP configuration changed and results need checking again.

No hook output is not proof that a check ran, and never proof that the whole project is clean. Run navigation, references, hover, tests, and builds as the task needs them.

## Environments

Use the environment already bound to the session. Do not assume the project uses Python, a `.venv` directory, or a particular environment manager.

An existing Conda or venv activation can be used as-is. TypeScript, Rust, Go, and other projects use their own toolchains; Python activation is not required.

If a call needs a different environment, select it and capture it in the same shell command, then pass the returned `environmentId` to the relevant LSP calls. In a shell that is already in the target environment:

```bash
node <plugin root>/dist/cli.js env capture --kind command
```

To switch first, select the environment in that same command, for example `conda activate <name> && node <plugin root>/dist/cli.js env capture --kind command` in a shell where Conda is initialized, or activate a venv that exists. Do not invent environment names, create environments, or edit shell startup files.

A command capture does not replace the session's default binding, and activating an environment inside a command does not change the running MCP server's environment. When no environment is bound, servers use the MCP process environment. Check `lsp.status` when the environment is unclear, after switching, or when a tool reports a problem.

The plugin root is two directories above this SKILL.md.

## Config

Most projects need no configuration. The built-in TypeScript server is chosen per project from its installed `node_modules/typescript`: below 7 through typescript-language-server, 7.x through the SDK's native LSP. Check `lsp.status` with `filePath` for the backend actually chosen instead of writing a route with absolute paths; a missing or broken SDK is reported there with its path.

Project config lives at `.codex/lsp-client.json`; user config lives at `~/.codex/lsp-client.json`. Add one only when the user wants a different server or the defaults cannot work:

```json
{
	"schemaVersion": 1,
	"servers": { "ruff": { "command": ["ruff", "server"] } },
	"languages": { "python": { "diagnosticServers": ["pyright", "ruff"] } }
}
```

When a tool reports a missing language server or an environment error, read `lsp.status` before changing configuration.
