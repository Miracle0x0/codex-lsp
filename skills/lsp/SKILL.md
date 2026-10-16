---
name: lsp
description: Use when Codex needs language-server diagnostics, definitions, implementations, references, hover types, call hierarchy, symbols, or rename safety checks in the current workspace.
---

# Codex LSP

Call `lsp` MCP tools through the tool interface; `lsp.*`/`mcp__lsp__*` are tool-call names, not shell commands.

Positions are a 1-based `line` and a 0-based `character` counted in Unicode code points.

## Tools

- `lsp.status`: list configured, installed, missing, disabled, and active language servers.
- `lsp.diagnostics`: check one file or directory for LSP diagnostics. Prefer `severity: "error"` after edits.
- `lsp.goto_definition`: locate a symbol definition from file, line, and character.
- `lsp.goto_implementation`: find implementations of an interface, abstract member, or type.
- `lsp.find_references`: find usages of a symbol across the workspace.
- `lsp.hover`: read the type and documentation of the symbol at a position.
- `lsp.symbols`: inspect document symbols or search workspace symbols.
- `lsp.prepare_call_hierarchy`: resolve the function at a position; pass an item's `handle` unchanged to `lsp.incoming_calls` (callers) or `lsp.outgoing_calls` (callees), and repeat with returned handles to walk deeper.
- `lsp.prepare_rename`: check whether a rename is valid at a position.
- `lsp.rename`: apply a language-server workspace edit for a rename.

## After Edits

The plugin's hooks check every `apply_patch` and shell command automatically and add new, resolved, or unattributed problems to the conversation; you do not need to call `lsp.diagnostics` after each edit, and never call `pre_edit_snapshot` or `post_edit_diagnostics` yourself. Call `lsp.diagnostics` for files or directories the edit did not touch, or when feedback says a check was incomplete.

## Environments

Results use the shell environment Codex was launched from (see `lsp.status` → `environment`). To analyze with an environment you activate inside a command, capture it in the same command and pass the printed id as `environmentId`:

```bash
source .venv/bin/activate && node <plugin root>/dist/cli.js env capture --kind command
```

The plugin root is two directories above this SKILL.md.

## Config

Project config lives at `.codex/lsp-client.json`; user config lives at `~/.codex/lsp-client.json`.

```json
{
	"schemaVersion": 1,
	"servers": { "ruff": { "command": ["ruff", "server"] } },
	"languages": { "python": { "diagnosticServers": ["pyright", "ruff"] } }
}
```

Use `lsp.status` first when diagnostics report a missing language server.
