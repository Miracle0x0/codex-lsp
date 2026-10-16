# codex-lsp

[![ci](https://github.com/code-yeongyu/codex-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/code-yeongyu/codex-lsp/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Codex plugin that ports the standalone LSP runtime from [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). It gives Codex post-edit diagnostics plus explicit MCP tools for language-aware code work.

## Documentation

| Guide | Contents |
|-------|----------|
| [Installation](docs/installation.md) | requirements, building the plugin, installing it into Codex, checking it works |
| [Shell environments](docs/environments.md) | `codex-lsp launch`, shell integration, command-scoped and pinned environments |
| [Post-edit diagnostics](docs/post-edit-diagnostics.md) | what the hooks check after `apply_patch` and shell commands, and what Codex is told |
| [Tools](docs/tools.md) | every `lsp.*` tool with parameters, results, and error codes |
| [Configuration](docs/configuration.md) | config files, adding and replacing servers, multi-source diagnostics, built-in routes |
| [Troubleshooting](docs/troubleshooting.md) | missing tools, silent hooks, wrong environments, slow or incomplete results |

## Quick Start

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm run test:package                     # stages artifacts/codex-lsp-plugin
codex plugin marketplace add /path/to/marketplace   # a marketplace listing the staged plugin
codex plugin add codex-lsp@<marketplace>
```

Enable `[features] mcp_2026_07_28 = true` in `~/.codex/config.toml`, trust the plugin's hooks, and start Codex from the shell whose environment should be analyzed:

```bash
source .venv/bin/activate
node artifacts/codex-lsp-plugin/dist/cli.js launch
```

Details, including the marketplace layout, are in [Installation](docs/installation.md).

## Architecture

The LSP runtime lives in [`lsp-tools-mcp`](https://github.com/code-yeongyu/lsp-tools-mcp), consumed here as a git submodule at `packages/lsp-tools-mcp/`.

- `lsp-tools-mcp` owns the MCP server, LSP process management, documents, diagnostics, edits, environment snapshots, and the standard tools.
- `codex-lsp` composes one long-running MCP process for Codex (`src/cli.ts`): the standard tools, two hook endpoints (`src/hook/`), Codex turn-metadata parsing (`src/codex-context.ts`), the environment binding, capture, and shell integration (`src/environment/`, `shell/`), the launcher (`src/launch.ts`), and the config printer (`src/config-mcp.ts`).

Codex calls the hook endpoints through native `mcp_tool` hooks, so edits are checked by the language servers that are already running instead of a new process per edit.

## Local Development

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm run build:all
pnpm run check:all
pnpm run test:all
pnpm run test:integration   # real Pyright, Ruff, typescript-language-server, gopls, clangd, rust-analyzer
pnpm run test:package
```

The root package depends on the runtime through `workspace:*`, so a missing submodule fails the install instead of silently using a stale build.

`pnpm test` covers the hook endpoints end to end against `dist/cli.js` with a fake language server. The real-host contract runs Codex itself in a temporary `CODEX_HOME`, installs the staged plugin, and checks that diagnostics reach the session after `apply_patch` and a shell command (needs network, Codex auth, and Pyright):

```bash
pnpm run test:package
CODEX_LSP_CONTRACT=1 pnpm exec vitest --run test/codex-contract.test.ts
```

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
