# Post-edit diagnostics

After Codex edits files, the plugin checks them with the language servers that are already running and adds what changed to the conversation. Nothing has to be called by hand, and an edit is never blocked or undone.

## How it works

`hooks/hooks.json` registers two native `mcp_tool` hooks for the `apply_patch` and `Bash` tools. Both call the plugin's own MCP server (`lsp`), so every check reuses the same language-server processes as the explicit tools.

| Hook | Endpoint | What it does |
|------|----------|--------------|
| PreToolUse | `pre_edit_snapshot` | For `apply_patch`: records the current diagnostics of the files the patch updates, deletes, or moves (skipped when an up-to-date record exists). For `Bash`: marks the workspace file-change journal. |
| PostToolUse | `post_edit_diagnostics` | Works out which files changed, tells every running language server, checks the changed files plus all documents already open in that workspace's servers, and compares the result with the record. |

How the changed files are found:

- `apply_patch`: from the patch headers (`Add File`, `Update File`, `Delete File`, `Update File` + `Move to`). A patch Codex reports as failed (`Exit code` other than 0) is ignored.
- `Bash`: Codex does not report what a command wrote, so the plugin keeps a file-change journal of the workspace. The pre-hook reconciles the watched tree with disk and records the event position and known files; the post-hook reconciles it again, so writes made before watcher registration finishes or without a notification are still detected. Watchers record intermediate changes, and atomically replacing an existing file is treated as a change. Delayed or duplicate notifications for unchanged files do not count as new edits, and directory notifications do not create deletion reports for files that were never observed. Dependency and build directories (`.git`, `node_modules`, `.venv`, `dist`, `build`, `target`, and others, plus `diagnostics.exclude`) are excluded from both watching and reconciliation. The journal stops at 4096 watched directories and reports incomplete coverage on every affected check, even with no recorded changes. Missing pre-hook records and closed journals are also reported.

## What is reported

Diagnostics are compared by provider, severity, code, and message, so problems that only moved because lines shifted are not reported again.

| Situation | Feedback |
|-----------|----------|
| new problems in an edited file | `<file>: N new problem(s)` with each diagnostic |
| a created file with problems | `<file>: new file with N problem(s)` |
| problems fixed by the edit | `<file>: N problem(s) resolved` |
| a file the session had not seen before (for example first changed by a shell command) | `first check in this session; N existing problem(s), not attributed to this edit` |
| the environment changed since the last check | current problems, marked as not attributed to this edit |
| an open document broke because of the edit (an importer) | its new problems |
| a provider failed, timed out, or is not installed | `Diagnostics incomplete:` with the reason; never hidden by the comparison |
| a file's diagnostics are unconfirmed | observed problems without edit attribution; the previous baseline is retained and no resolution is claimed |
| nothing new, a failed patch, or files without a configured language | no feedback |

At most 20 diagnostics are listed in Hook text; the rest are counted. Baselines and Hook structured results retain every collected diagnostic, and all open related files are eligible for checking. For direct inspection, `lsp.diagnostics` has a `limit` parameter (default 200); increase it when the result says `truncated`. Errors and warnings are reported by default; set `diagnostics.minimumSeverity` in the [configuration](configuration.md) to change that.

Example, after a patch that assigns a string to an `int`:

```text
LSP diagnostics after apply_patch (1 edited file(s)):
/work/app/main.py: 1 new problem(s)
  /work/app/main.py:1:13 error [pyright/Pyright reportAssignmentType] Type "Literal['text']" is not assignable to declared type "int"
```

Each line is `path:line:character severity [provider/source code] message`, with the same position convention as the tools.

`lsp.rename` checks the files it wrote and stores the result as the new record, so the next edit does not re-report the rename's own results.

## Timing

The checks run while Codex waits for the hook (timeouts: 30 s PreToolUse, 60 s PostToolUse). Measured on Linux with small projects: Pyright checks an edit in about 10 ms, typescript-language-server in about 360 ms, and rust-analyzer in about 620 ms (it waits for rust-analyzer's `cargo check`, whose errors such as borrow-checker failures are merged in). The first time a TypeScript edit leaves diagnostics unchanged it takes about 1.9 s, because typescript-language-server does not republish unchanged results; after that the runtime knows and asks it to re-analyze immediately. The first check in a workspace also starts the language server.

## Limits

- Hooks only run after they are trusted in Codex, and only when the `lsp` MCP server is connected; a hook never starts or reconnects the server.
- Codex does not show hook failures in the conversation. If feedback never appears, see [Troubleshooting](troubleshooting.md).
- Push-diagnostics servers report what they analyzed; a clean check of the edited files is not a full project build.
