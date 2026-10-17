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
pnpm install --frozen-lockfile
pnpm run test:package                     # stages artifacts/codex-lsp-plugin
codex plugin marketplace add "$PWD"       # this repository is the codex-lsp-local marketplace
codex plugin add codex-lsp@codex-lsp-local
```

Enable `[features] mcp_2026_07_28 = true` in `~/.codex/config.toml`, trust the plugin's hooks, and start Codex from the shell whose environment should be analyzed:

```bash
source .venv/bin/activate
node artifacts/codex-lsp-plugin/dist/cli.js launch
```

Details, including updates and installing a copied plugin on another machine, are in [Installation](docs/installation.md).

## Architecture

This repository is one pnpm package with two internal layers:

- `src/core/` owns the MCP server, LSP processes, documents, diagnostics, workspace edits, configuration, and environment snapshots.
- `src/codex/` owns Codex metadata, edit hooks, shell capture and integration, the launcher, and configuration output.
- `src/cli.ts` composes both layers into one long-running MCP process; `test/core/`, `test/codex/`, and `test/integration/` cover them at their respective boundaries.

Codex calls the hook endpoints through native `mcp_tool` hooks, so checks reuse the language servers serving explicit tools. The architecture and implementation are described in [DESIGN-zh.md](DESIGN-zh.md).

## Local Development

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm run test
pnpm run test:integration   # real Python, TypeScript 6/7, Go, C++, Rust servers
pnpm run test:package
```

Development, CI, and plugin packaging use one root `package.json` and `pnpm-lock.yaml`. TypeScript 7 builds the plugin; real integration tests cover TypeScript 6 through typescript-language-server and TypeScript 7 through its native LSP/compiler. Both SDKs are development-only dependencies.

`pnpm test` covers the hook endpoints end to end against `dist/cli.js` with a fake language server. The real-host contract runs Codex itself in a temporary `CODEX_HOME`, installs the staged plugin, and checks that diagnostics reach the session after `apply_patch` and a shell command (needs network, Codex auth, and Pyright):

```bash
pnpm run test:package
CODEX_LSP_CONTRACT=1 pnpm run test:contract
```

## Branch Rules and Releases

- `main` is protected by `.github/branch-ruleset.json`.
- CI runs Node 20, 22, and 24 on Ubuntu, macOS, and Windows.
- Releases are GitHub Releases tagged as `v<semver>`; the version in `package.json` and `.codex-plugin/plugin.json` must match.
- The package is not published to npm. Users build the plugin from source and install it from the repository's local marketplace (see [Installation](docs/installation.md)).

## Privacy

This plugin runs locally. It starts configured language-server commands on your machine and does not call a network service by itself.

## License

[MIT](LICENSE).

## Related

- [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) - source extension this Codex plugin ports.
