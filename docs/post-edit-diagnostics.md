# Post-edit diagnostics

After Codex edits files, the plugin checks them with the configured language servers and adds what changed to the conversation. Servers start on demand and are reused for later checks. Nothing has to be called by hand, and an edit is never blocked or undone.

## How it works

`hooks/hooks.json` registers two native `mcp_tool` hooks for the `apply_patch` and `Bash` tools. Both call the plugin's own MCP server (`lsp`), so every check reuses the same language-server processes as the explicit tools.

| Hook | Endpoint | What it does |
|------|----------|--------------|
| PreToolUse | `pre_edit_snapshot` | For `apply_patch`: records the current diagnostics of the files the patch updates, deletes, or moves (skipped when an up-to-date record exists). For `Bash`: marks the workspace file-change journal. |
| PostToolUse | `post_edit_diagnostics` | Works out which files changed, tells every running language server, checks the changed files plus files with a diagnostic baseline in this session and workspace, and compares the result with the record. |

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
| a previously baselined file broke because of the edit (an importer) | its new problems |
| a provider failed, timed out, or is not installed | `Diagnostics incomplete:` with the reason; never hidden by the comparison |
| a file's diagnostics are unconfirmed | observed problems without edit attribution; the previous baseline is retained and no resolution is claimed |
| nothing new, a failed patch, or files without a configured language | no feedback |

At most 20 diagnostics are listed in Hook text; the rest are counted. Baselines and Hook structured results retain every collected diagnostic, and all related files with a baseline are eligible for checking. Baselines contain content hashes and diagnostics, not file text or open LSP documents. For direct inspection, `lsp.diagnostics` has a `limit` parameter (default 200); increase it when the result says `truncated`. Errors and warnings are reported by default; set `diagnostics.minimumSeverity` in the [configuration](configuration.md) to change that.

Example, after a patch that assigns a string to an `int`:

```text
LSP diagnostics after apply_patch (1 edited file(s)):
/work/app/main.py: 1 new problem(s)
  /work/app/main.py:1:13 error [pyright/Pyright reportAssignmentType] Type "Literal['text']" is not assignable to declared type "int"
```

Each line is `path:line:character severity [provider/source code] message`, with the same position convention as the tools.

`lsp.rename` checks the files it wrote and stores the result as the new record, so the next edit does not re-report the rename's own results.

## Timing

The checks run while Codex waits for the hook (timeouts: 30 s PreToolUse, 60 s PostToolUse). The first check in a workspace also starts the language server. Checks synchronize the saved file contents and send save notifications when the server requests them; for rust-analyzer, this triggers `cargo check`, whose errors such as borrow-checker failures are merged into the result.

A document stays open while requests use it and closes after its last concurrent request finishes, including failure or cancellation. Closing releases its text and push/pull diagnostic caches; later requests reopen it with a fresh version. The language-server process remains available for reuse, and the session's baselines continue to support comparisons across edits.

## Limits

- Hooks only run after they are trusted in Codex, and only when the `lsp` MCP server is connected; a hook never starts or reconnects the server.
- Codex does not show hook failures in the conversation. If feedback never appears, see [Troubleshooting](troubleshooting.md).
- Push-diagnostics servers report what they analyzed; a clean check of the edited files is not a full project build.
