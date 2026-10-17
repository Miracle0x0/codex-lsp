# codex-lsp documentation

Usage guides for the codex-lsp Codex plugin. For development and release workflow, see the [repository README](../README.md) and [AGENTS.md](../AGENTS.md).

| Guide | Read it when you want to |
|-------|--------------------------|
| [Installation](installation.md) | build the plugin, install it into Codex, and check that it works |
| [Shell environments](environments.md) | make diagnostics use your activated venv, Conda env, Node, Go, or other toolchain |
| [Post-edit diagnostics](post-edit-diagnostics.md) | understand the feedback Codex gets after `apply_patch` and shell commands |
| [Tools](tools.md) | call the `lsp.*` MCP tools directly, with their parameters and results |
| [Configuration](configuration.md) | add, replace, or disable language servers and tune diagnostics |
| [Adding language servers](adding-language-servers.md) | support another language server, through configuration or as a built-in route |
| [Troubleshooting](troubleshooting.md) | fix missing tools, silent hooks, unbound environments, and server failures |

Conventions used throughout:

- Positions are a 1-based `line` and a 0-based `character` counted in Unicode code points. The runtime converts them to the UTF-16 offsets language servers use, so emoji and CJK text do not shift columns.
- Paths may be absolute or relative to the workspace root. Codex supplies the workspace with every tool call; outside Codex, pass `workspaceRoot`.
- Language servers are not bundled. They come from the environment the plugin is bound to (see [Shell environments](environments.md)), and a missing one is reported with an install hint.
