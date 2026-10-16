# Tools

The plugin's MCP server is named `lsp`; Codex shows its tools as `lsp.<tool>` (and `mcp__lsp__<tool>` in some views). They are tool calls, not shell commands.

## Common parameters

| Parameter | Meaning |
|-----------|---------|
| `filePath` | File (or, for `diagnostics`, a directory). Absolute, or relative to the workspace root. |
| `line` | 1-based line number (integer). |
| `character` | 0-based column counted in Unicode code points (integer). |
| `workspaceRoot` | Absolute workspace root. Codex supplies it with every call; pass it only when working outside Codex or when a session has several workspaces. |
| `environmentId` | A captured environment to analyze with instead of the bound one (see [Shell environments](environments.md)). |
| `server` | A server id to ask instead of the language's semantic server (navigation and rename tools). |

Every tool returns a text summary and `structuredContent` that matches its output schema. Locations are `{ "path", "range": { "start": { "line", "character" }, "end": { ... } } }` in the same coordinates.

## Status and diagnostics

| Tool | Parameters | Result |
|------|------------|--------|
| `status` | `filePath?` | Config files and errors, the bound environment (id, generation, source), every server with its executable or "not found", language routes, and running clients. With `filePath`: the file's project root and resolved toolchain (interpreter or SDK, version, notes). Starts no language server. |
| `diagnostics` | `filePath`, `severity?` (`error`, `warning`, `information`, `hint`; default from config, else all), `servers?`, `timeoutMs?` (default 20000), `maxFiles?`, `limit?` (default 200) | A diagnostics batch: every provider's status (`ok`, `timeout`, `failed`, `not_installed`, `unavailable`, `not_configured`, `cancelled`), each file's freshness (`confirmed`, `observed`, `unconfirmed`), coverage (scanned, checked, unsupported files), counts, and diagnostics with `providerId`. A directory checks every configured language. |

`complete: false` comes with `incompleteReasons`: a provider that did not finish, or a result the server did not confirm after other files changed. When a provider did not finish, the tool result is also marked as an error, although it still carries the diagnostics that were collected.

## Navigation

| Tool | Parameters | Result |
|------|------------|--------|
| `goto_definition` | position | `locations` of the definition |
| `goto_implementation` | position | `locations` of implementations of an interface, abstract member, or type |
| `find_references` | position, `includeDeclaration?` (default true), `limit?` (default 200) | `references`, `total`, `truncated` |
| `hover` | position | `hover: { kind, contents, range? }`, or `null` when the server has nothing |
| `symbols` | `filePath`, `scope?` (`document` default, or `workspace`), `query?` (required for workspace), `limit?` (default 200) | `symbols` with name, kind, nesting depth, path, range, and container; `total`, `truncated` |

"Position" means `filePath`, `line`, `character`.

## Call hierarchy

1. `prepare_call_hierarchy` (position) returns `items`, each with `name`, `kind`, `path`, `range`, and an opaque `handle`.
2. `incoming_calls` (`item`: a handle) returns `calls`, each with the caller `item` and `fromRanges`, the call sites inside the caller.
3. `outgoing_calls` (`item`: a handle) returns `calls`, each with the callee `item` and `fromRanges`, the call sites inside the item you passed.

Returned items have handles too, so you can keep walking. A handle remembers which server, workspace, and environment produced it and carries the server's private data; pass it unchanged. A modified handle is rejected with `invalid_input`.

## Rename

| Tool | Parameters | Result |
|------|------------|--------|
| `prepare_rename` | position | `canRename`, and when the server reports them, the `range` to rename and a `placeholder` |
| `rename` | position, `newName` | `applied`, `operationId`, `editCount`, `changes` (created, changed, deleted files), `completed` / `failed` / `skipped` operations, and `diagnostics` for the changed files |

`rename` writes files. Before writing, it rejects edits for documents whose version or disk text changed, overlapping edits, and invalid resource operations; then it applies them in order and syncs every language server. If a write fails midway, it stops and lists what was done and what was skipped (there is no rollback). Run renames one at a time.

## Errors

Failures of the tool itself are error results whose text starts with a code in brackets. Code problems found by `diagnostics` are normal results.

| Code | Meaning |
|------|---------|
| `invalid_input` | A parameter is out of range or malformed (for example a fractional line or a tampered handle). |
| `invalid_path` | The file does not exist, is a directory, or a relative path has no workspace root. |
| `config_invalid` | A config file failed validation; the message names the file and field. |
| `environment_error` | The requested environment has no snapshot, or its toolchain could not be resolved. |
| `server_not_configured` | No language is configured for the file's extension. |
| `server_not_installed` | The configured server executable is not on the bound environment's `PATH`; the message includes the install hint. |
| `server_start_failed`, `server_exited` | The server failed to initialize or crashed. |
| `timeout`, `cancelled` | The request took too long, or the call was cancelled (the server is told to cancel too). |
| `capability_unsupported` | The server does not offer this feature (for example Pyright has no implementation provider). |
| `request_failed`, `edit_failed`, `internal_error` | The server returned an error, a workspace edit could not be applied, or an unexpected failure. |

`pre_edit_snapshot` and `post_edit_diagnostics` also appear in the tool list. They are hook endpoints (see [Post-edit diagnostics](post-edit-diagnostics.md)) and are not meant to be called directly.
