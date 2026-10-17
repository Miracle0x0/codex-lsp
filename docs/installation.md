# Installation

## Requirements

- Codex CLI with the `mcp_2026_07_28` feature (verified with Codex 0.163.0). The plugin speaks only the `2026-07-28` MCP revision.
- Node.js 20 or newer on `PATH` (Codex starts the plugin with `node`).
- The language servers for your languages, on the `PATH` of the environment you work in. Common ones:

| Language | Server | Install |
|----------|--------|---------|
| Python | `pyright-langserver` (Pyright); optional `ruff` | `npm install -g pyright`; `pipx install ruff` |
| TypeScript / JavaScript | `typescript-language-server`, plus `typescript` in the project | `npm install -g typescript-language-server`; `npm install -D typescript` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| C / C++ | `clangd` (reads `compile_commands.json`) | your system package manager |

Other languages have built-in routes too; `lsp.status` lists every configured server and whether it was found. See [Configuration](configuration.md) for the full list and for adding servers.

## Build the plugin

From a checkout of this repository:

```bash
pnpm install --frozen-lockfile
pnpm run test:package
```

`test:package` builds the single package and stages its distributable files in `artifacts/codex-lsp-plugin/`. It installs production dependencies from the root lockfile with a flat (hoisted) `node_modules`, then verifies the relocated plugin. Codex drops symbolic links when it installs a plugin, so install from this staged directory, not from the source tree.

## Install into Codex

1. Register this repository as a local marketplace and install the plugin. The repository's [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json) is named `codex-lsp-local` and lists the staged `./artifacts/codex-lsp-plugin` (paths are relative to the repository root, not to `.agents/plugins/`). Listing a plugin as enabled in `config.toml` is not enough; it must be installed:

   ```bash
   cd /path/to/codex-lsp
   codex plugin marketplace add "$PWD"
   codex plugin add codex-lsp@codex-lsp-local
   ```

   Codex copies the staged directory into its plugin cache, so run `test:package` before `plugin add`. Codex does not pick up this marketplace by opening the repository; only `marketplace add` registers it.

2. Enable the protocol revision in `~/.codex/config.toml` (add the key to an existing `[features]` table):

   ```toml
   [features]
   mcp_2026_07_28 = true
   ```

3. Start Codex and trust the plugin's hooks. Codex runs hooks only with persisted hook trust; until then the tools work but edits are not checked automatically. For unattended runs that already vet the hook source, `codex exec --dangerously-bypass-hook-trust` skips the check for that one invocation.

To update, run `pnpm run test:package` and `codex plugin add codex-lsp@codex-lsp-local` again, then start a new session; the installed copy does not follow the artifact directory by itself. Review hook trust again if the hooks changed. `codex plugin remove codex-lsp@codex-lsp-local` uninstalls it; it removes Codex's copy, not the repository, the staged artifact, or environment snapshots.

### Installing on another machine

codex-lsp is not published to npm. To install without building, copy the whole `artifacts/codex-lsp-plugin/` directory (or an archive of it that keeps hidden files such as `.codex-plugin/` and `.mcp.json`, and the production `node_modules/`) into a marketplace directory of your own:

```text
my-marketplace/
├── .agents/plugins/marketplace.json
└── plugins/codex-lsp/        <- copy of artifacts/codex-lsp-plugin/
```

`marketplace.json`:

```json
{
	"name": "local",
	"plugins": [
		{
			"name": "codex-lsp",
			"source": { "source": "local", "path": "./plugins/codex-lsp" },
			"policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }
		}
	]
}
```

Then run `codex plugin marketplace add /path/to/my-marketplace` and `codex plugin add codex-lsp@local`. To update, replace `plugins/codex-lsp/` completely and run `plugin add` again. The receiving machine still needs Node.js and its own language servers. A plain source archive is not installable; it must be built first.

## Check that it works

In a Codex session inside a project:

1. Ask Codex to call `lsp.status`. It should list the configured servers, which of them were found, and the bound environment.
2. Ask Codex to introduce a type error with `apply_patch`. The next turn should contain a block starting with `LSP diagnostics after apply_patch`.

If either step fails, see [Troubleshooting](troubleshooting.md).

## What the plugin contains

| File | Purpose |
|------|---------|
| `.codex-plugin/plugin.json` | Plugin manifest (Codex compat layout) |
| `.mcp.json` | The `lsp` MCP server: `node ./dist/cli.js mcp` started from the plugin directory, with `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` and the forwarded environment-binding variables |
| `hooks/hooks.json` | `mcp_tool` hooks on `apply_patch` and `Bash` (see [Post-edit diagnostics](post-edit-diagnostics.md)) |
| `skills/lsp/SKILL.md` | Guidance Codex reads about when and how to use the tools |
| `shell/` | Shell integration templates (see [Shell environments](environments.md)) |
| `dist/`, `node_modules/` | The CLI, `codex/` adapter, `core/` runtime, and their production dependencies |

## Using codex-lsp without the plugin system

`codex-lsp config mcp` prints `config.toml` sections (feature flag, MCP server, and both hooks) pointing at this installation. Review them and add them to `~/.codex/config.toml` yourself; the command changes nothing:

```bash
node /path/to/codex-lsp/dist/cli.js config mcp
```

Hooks configured this way also need to be trusted in Codex.

## Validation in CI

CI installs every tool the test suites use and sets `CODEX_LSP_REQUIRE_TOOLS=1`, so a missing tool fails a job instead of skipping tests (locally, such suites are skipped with the reason). The operating-system and Node matrix runs the default and platform suites and verifies the plugin package; integration runs one job per language with pinned servers, and the Python job installs Conda so the tests can create their own environments. TypeScript tests exercise both the pinned TypeScript 6 SDK through typescript-language-server and the pinned TypeScript 7 native LSP and compiler. For real Codex tests, manually start `ci` with `codex_contract` enabled and configure the repository secret `CODEX_AUTH_JSON` with the test account's authentication JSON. The job uses Codex 0.163.0, builds the plugin, runs the host contract cases in temporary Codex homes, and removes its temporary authentication file. Missing authentication fails the requested job. The contract bypasses Hook trust for its isolated invocations; interactive trust and desktop/IDE behavior require separate host verification.
