# Troubleshooting

Start with `lsp.status` (ask Codex to call it, optionally with a `filePath`). It shows which config files loaded, the bound environment, every server's executable or "not found", running clients, and the resolved toolchain for a file.

## The `lsp` tools do not appear in Codex

- Enable the protocol revision: `[features] mcp_2026_07_28 = true` in `~/.codex/config.toml`. Without it Codex uses the old handshake, which the server rejects.
- Check that the plugin is installed (`codex plugin add codex-lsp@<marketplace>`), not only listed in `config.toml`.
- Install from the staged artifact (`pnpm run test:package` → `artifacts/codex-lsp-plugin`). A copy of the source tree has symlinked dependencies that Codex drops on install, and the server then fails to start.
- `node` must be on Codex's `PATH`, version 20 or newer.

## Edits get no diagnostics feedback

- Trust the plugin's hooks in Codex. Untrusted hooks do not run, and Codex does not say so in the conversation.
- Feedback is empty when nothing changed for the better or worse, when the file's extension has no configured language, or when the patch failed. Call `lsp.diagnostics` on the file to see its full state.
- `.mcp.json` must keep `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` in `env`; without it Codex 0.163.0 fails every `mcp_tool` hook call while ordinary tool calls still work.
- Shell commands are tracked through file watchers that start with the first hook in a workspace. Files under ignored directories (`node_modules`, `dist`, `build`, `target`, `.venv`, `diagnostics.exclude`, ...) are not watched; very large trees beyond 4096 directories are reported as incomplete.

## `[server_not_installed]` or a provider is `not_installed`

The server executable is not on the `PATH` of the bound environment. Install it (the message includes the hint), or check that the environment you expect is bound: a tool installed only in a venv is visible only when that venv is the bound environment. `lsp.status` shows which `PATH` was searched (`environment.source`).

## Diagnostics use the wrong Python, Node, or toolchain

- `lsp.status` with `filePath` shows the interpreter or SDK and where it came from. `source: "unbound"` means no shell environment is bound; start Codex with `codex-lsp launch` from the activated shell (see [Shell environments](environments.md)). `Environment: unusable` or `[environment_error] the launcher's environment binding is unusable` means the launcher's variables were malformed; restart Codex with `codex-lsp launch`.
- "VIRTUAL_ENV is ... but the PATH interpreter ..." means the snapshot is inconsistent (for example `VIRTUAL_ENV` exported without activating). Activate the environment properly, or pin `environment.python.interpreter`.
- After activating another environment, the next check uses it if the shell integration is installed (it records a new generation at the next prompt) or after relaunching with `codex-lsp launch`.
- Pyright cannot resolve editable installs that rely on import hooks; that is a Pyright limitation.

## TypeScript errors such as "Cannot find module" or initialization failures

typescript-language-server needs the `typescript` package in the project (`npm install -D typescript`); the plugin does not lend its own. A custom `typescript` server definition must keep `tsserver.useSyntaxServer: "never"` (see [Configuration](configuration.md)).

## Rust results are slow or incomplete

The first check waits until rust-analyzer has loaded the workspace (a few seconds on first start). After an edit, the check also waits for rust-analyzer's `cargo check`, whose errors (for example borrow-checker errors) arrive separately and are merged in. A check that is still waiting when the timeout (`timeoutMs`, default 20 s) passes is returned as unconfirmed with the reason; if a server never becomes idle, later checks stop waiting for it.

## A result says "incomplete" or "unconfirmed"

| Reason | Meaning |
|--------|---------|
| `<server> (<language>): [timeout] ...` | The server published nothing within `timeoutMs`. |
| `did not confirm diagnostics ... after other files changed` | The server did not re-analyze the file after a dependency changed; the result may be stale. |
| `was still busy (...)` | The server was still working when the timeout passed. |
| `File changes may be incomplete: ...` | The file-change journal could not watch every directory or dropped events. |

## Where the logs are

The MCP server writes warnings (for example an ignored environment binding) to stderr, which Codex keeps in its own logs. Language-server stderr appears in error messages when a server fails to start or exits.
