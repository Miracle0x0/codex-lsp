# codex-lsp

[![ci](https://github.com/code-yeongyu/codex-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/code-yeongyu/codex-lsp/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Codex plugin that ports the standalone LSP runtime from [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). It gives Codex post-edit diagnostics plus explicit MCP tools for language-aware code work.

## Architecture

The LSP runtime lives in [`lsp-tools-mcp`](https://github.com/code-yeongyu/lsp-tools-mcp), consumed here as a git submodule at `packages/lsp-tools-mcp/`.

- `lsp-tools-mcp` owns the MCP server, LSP process management, documents, diagnostics, edits, and the standard tools.
- `codex-lsp` composes one long-running MCP process for Codex (`src/cli.ts`): the standard tools, two hook endpoints (`src/hook/`), Codex turn-metadata parsing (`src/codex-context.ts`), and the launch environment binding (`src/environment-binding.ts`).

Codex calls the hook endpoints through native `mcp_tool` hooks, so edits are checked by the language servers that are already running instead of a new process per edit.

## Post-Edit Diagnostics

| Case | Result |
|------|--------|
| `apply_patch` (add, update, delete, move) | PreToolUse records diagnostics for files the patch will touch; PostToolUse syncs servers with the change and checks the result |
| `Bash` command | PreToolUse marks the workspace file-change journal; PostToolUse checks files the command created or changed (dependency and build directories are not watched) |
| new problems | reported as `additionalContext` with file, position, provider, code, and message; the edit is never blocked |
| problems that existed before | not reported again; a file first seen through a shell command is labelled "not attributed to this edit" |
| fixed problems | reported as resolved |
| documents already open in a language server | rechecked so breakage in importers shows up |
| failed patch, unsupported extension, or nothing new | empty hook output |
| provider failure, timeout, or missing server | reported, never deduplicated away |

Errors and warnings are reported by default; set `diagnostics.minimumSeverity` in the config to change that. `lsp.rename` checks the files it writes and feeds the same baseline, so a following edit does not re-report the rename's results.

## MCP Tools

- `lsp.status`
- `lsp.diagnostics`
- `lsp.goto_definition`
- `lsp.goto_implementation`
- `lsp.find_references`
- `lsp.hover`
- `lsp.symbols`
- `lsp.prepare_call_hierarchy`
- `lsp.incoming_calls`
- `lsp.outgoing_calls`
- `lsp.prepare_rename`
- `lsp.rename`

`lsp.rename` applies the returned workspace edit to files. Use `lsp.prepare_rename` first when possible.

`pre_edit_snapshot` and `post_edit_diagnostics` are also listed; they are the hook endpoints and are not meant to be called by the model.

## Shell Environments

Diagnostics and navigation use the language environment of the shell you work in (an activated venv, uv project environment, Conda env, Node version, Go or Rust toolchain), not the environment Codex happened to start the plugin with. A process cannot read another shell's variables, so the shell hands them over explicitly:

| Entry | Use |
|-------|-----|
| `codex-lsp launch [codex args...]` | Run instead of `codex` from the shell whose environment should be used. It captures a launch snapshot and starts `codex --no-daemon` with `CODEX_LSP_CONTEXT_ID` / `CODEX_LSP_ENV_MANIFEST` set; the plugin's MCP server reads them. Without `--no-daemon`, a shared Codex daemon would keep its own start-up environment. |
| `eval "$(codex-lsp env shell-init zsh)"` (also `bash`, `pwsh`) | Shell integration for your rc file. It gives the shell its own environment id and records a new generation at the next prompt whenever the watched variables or the directory change. Existing prompt hooks and exit codes are kept. |
| `codex-lsp env capture --kind command` | Snapshots the calling environment and prints its id; tools accept it as `environmentId` (for example after `source .venv/bin/activate` in one command). |
| `codex-lsp config mcp [--environment-id <id>]` | Prints reviewable `config.toml` for using codex-lsp without the plugin, optionally pinned to one shell's environment id (a desktop or daemon-hosted Codex then follows that shell's activations). Nothing is written. |

Run the CLI as `node <plugin>/dist/cli.js` or from an npm install (`codex-lsp`). Snapshots live in `$XDG_STATE_HOME/codex-lsp` (or `~/.local/state/codex-lsp`, `%LOCALAPPDATA%\codex-lsp`; override with `CODEX_LSP_STATE_DIR`), only contain the variables language tooling needs, and are written with private permissions. Without any binding, `lsp.status` reports the environment as unbound and tools use the MCP process environment.

## Configuration

Project config:

```text
.codex/lsp-client.json
```

User config:

```text
~/.codex/lsp-client.json
```

Example:

```json
{
	"schemaVersion": 1,
	"servers": { "ruff": { "command": ["ruff", "server"] } },
	"languages": { "python": { "diagnosticServers": ["pyright", "ruff"] } }
}
```

Each language routes to one built-in server by default; the example adds Ruff next to Pyright for Python diagnostics. `status` shows the bound environment, which servers are installed in it, and active clients. Full schema and merge rules: [`lsp-tools-mcp` configuration](packages/lsp-tools-mcp/README.md#configuration).

## Codex Plugin

The plugin ships:

- `.codex-plugin/plugin.json` for Codex plugin discovery (Codex compat layout).
- `.mcp.json` for the `lsp` MCP server, started from the plugin root with `node ./dist/cli.js mcp`. It sets `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` (without it Codex 0.163.0 fails every `mcp_tool` hook call) and forwards `CODEX_LSP_CONTEXT_ID` / `CODEX_LSP_ENV_MANIFEST`, the shell environment captured at launch.
- `hooks/hooks.json` with `mcp_tool` hooks on `apply_patch` and `Bash`: `pre_edit_snapshot` (PreToolUse) and `post_edit_diagnostics` (PostToolUse) on the `lsp` server.
- `skills/lsp/SKILL.md` with MCP usage guidance.

The runtime depends on `@code-yeongyu/lsp-tools-mcp` via `workspace:*`. Marketplace builds come from `pnpm run test:package`, which builds both packages and stages a self-contained plugin under `artifacts/codex-lsp-plugin` with a hoisted `node_modules` (Codex drops symbolic links when it installs a plugin).

Requirements: Codex with the `mcp_2026_07_28` feature enabled, Node 20 or newer, and the language servers for your languages on `PATH`.

## Local Development

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm run build:all
pnpm run check:all
pnpm run test:all
pnpm run test:integration   # real Pyright, Ruff, typescript-language-server, gopls
pnpm run test:package
```

The root package depends on the runtime through `workspace:*`, so a missing submodule fails the install instead of silently using a stale build.

`pnpm test` covers the hook endpoints end to end against `dist/cli.js` with a fake language server. The real-host contract runs Codex itself in a temporary `CODEX_HOME`, installs the staged plugin, and checks that diagnostics reach the session after `apply_patch` and a shell command (needs network, Codex auth, and Pyright):

```bash
pnpm run test:package
CODEX_LSP_CONTRACT=1 pnpm exec vitest --run test/codex-contract.test.ts
```

## Local Codex Installation

Point a local marketplace at a directory whose `.agents/plugins/marketplace.json` lists the staged plugin (`artifacts/codex-lsp-plugin`), then:

```bash
codex plugin marketplace add /path/to/marketplace
codex plugin add codex-lsp@<marketplace-name>
```

and enable the protocol revision in `~/.codex/config.toml`:

```toml
[features]
mcp_2026_07_28 = true
```

Plugin hooks run after you trust them in Codex.

## Branch Rules and Releases

- `main` is protected by `.github/branch-ruleset.json`.
- CI runs Node 20, 22, and 24 on Ubuntu, macOS, and Windows.
- Releases are GitHub Releases tagged as `v<semver>`.
- Publishing runs from the `publish` workflow after a GitHub Release is published.

## Privacy

This plugin runs locally. It starts configured language-server commands on your machine and does not call a network service by itself.

## License

[MIT](LICENSE).

## Related

- [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) - source extension this Codex plugin ports.
