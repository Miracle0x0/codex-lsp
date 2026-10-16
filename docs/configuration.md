# Configuration

Most projects need no configuration: each language routes to a built-in server. Configuration adds servers, runs several diagnostic sources for one language, replaces or disables servers, and tunes diagnostics and environments.

## Files

| Layer | Location | Override |
|-------|----------|----------|
| Built-in | shipped with the runtime | |
| User | `~/.codex/lsp-client.json` | `LSP_TOOLS_MCP_USER_CONFIG` (absolute, or relative to your home directory) |
| Project | `<workspace root>/.codex/lsp-client.json` | `LSP_TOOLS_MCP_PROJECT_CONFIG` (absolute, or relative to the workspace root) |

Layers merge in that order. Changes are picked up on the next tool call without restarting Codex; an invalid file makes tools fail with `[config_invalid]`, naming the file and field. `lsp.status` shows which files were loaded.

Every file needs `"schemaVersion": 1`. Unknown fields are errors, so typos do not pass silently.

## Examples

Run Ruff next to Pyright for Python diagnostics:

```json
{
	"schemaVersion": 1,
	"languages": { "python": { "diagnosticServers": ["pyright", "ruff"] } }
}
```

Use basedpyright instead of Pyright for Python (semantic tools and diagnostics):

```json
{
	"schemaVersion": 1,
	"languages": { "python": { "semanticServer": "basedpyright", "diagnosticServers": ["basedpyright"] } }
}
```

Add a server and a language for it:

```json
{
	"schemaVersion": 1,
	"servers": {
		"marksman": { "command": ["marksman", "server"], "installHint": "brew install marksman" }
	},
	"languages": {
		"markdown": { "extensions": [".md"], "semanticServer": "marksman", "diagnosticServers": ["marksman"] }
	}
}
```

Disable a server in one project. Routes that name it drop it, and `lsp.status` lists it as disabled; here C and C++ files get no server:

```json
{
	"schemaVersion": 1,
	"servers": { "clangd": { "disabled": true } }
}
```

Pass settings and initialization options:

```json
{
	"schemaVersion": 1,
	"servers": {
		"pyright": {
			"command": ["pyright-langserver", "--stdio"],
			"settings": { "python": { "analysis": { "typeCheckingMode": "strict" } } }
		}
	}
}
```

Replacing a server replaces its whole definition, including built-in initialization options. If you redefine `typescript`, keep `"initializationOptions": { "tsserver": { "useSyntaxServer": "never" } }`; without it, first requests return single-file results while the project loads.

Report only errors after edits, and skip generated code in directory checks:

```json
{
	"schemaVersion": 1,
	"diagnostics": { "minimumSeverity": "error", "exclude": ["generated", "src/vendor"] }
}
```

Pin the Python interpreter instead of following the shell:

```json
{
	"schemaVersion": 1,
	"environment": { "python": { "interpreter": ".venv-tools/bin/python" } }
}
```

## Fields

`servers.<id>` (ids use lowercase letters, digits, `.`, `_`, `-`):

| Field | Meaning |
|-------|---------|
| `command` | Executable and arguments. Bare names are looked up on the bound environment's `PATH`; relative paths resolve against the workspace root. |
| `env` | Extra environment variables for the server process. |
| `settings` | Answered to `workspace/configuration` requests. |
| `initializationOptions` | Sent with `initialize`. |
| `rootMarkers` | Files or directories that mark a project root. The nearest directory above the file that has one is the project root, without leaving the workspace; this keeps monorepo packages apart. |
| `installHint` | Shown when the executable is missing. |
| `disabled: true` | Turns the server off (only this field). |

`languages.<id>`:

| Field | Meaning |
|-------|---------|
| `extensions` | File extensions such as `".py"`; an extension may belong to one language only. |
| `languageId` | LSP language id sent with documents (defaults to the standard id for the file's extension). |
| `toolchain` | `python`, `node`, `rust`, `go`, `java`, `cpp`, or `null`; selects the environment adapter. |
| `semanticServer` | Server for navigation, hover, call hierarchy, and rename; `null` for none. |
| `diagnosticServers` | Servers whose diagnostics are combined; each result keeps its `providerId`. |
| `disabled: true` | Turns the language off. |

Languages merge field by field across layers; arrays are replaced, not appended.

`diagnostics`: `minimumSeverity` (`error`, `warning`, `information`, `hint`; the default is warnings and errors for hook feedback and everything for `lsp.diagnostics`) and `exclude` (directory names or workspace-relative prefixes skipped by directory checks and the file-change journal).

`environment`: `source` (`active-shell`, the default, uses the bound shell snapshot; `process` uses the MCP server's own environment), `python.interpreter`, and `extraVariables` (more variable names to capture in snapshots).

## Built-in routes

| Language | Extensions | Default server (command) |
|----------|------------|--------------------------|
| TypeScript, JavaScript | `.ts .tsx .mts .cts`, `.js .jsx .mjs .cjs` | `typescript` (`typescript-language-server --stdio`) |
| Python | `.py .pyi` | `pyright` (`pyright-langserver --stdio`) |
| Go | `.go` | `gopls` |
| Rust | `.rs` | `rust` (`rust-analyzer`) |
| C, C++ | `.c .cc .cpp .cxx .h .hpp` and similar | `clangd` (`clangd --background-index --clang-tidy`) |
| Java, Kotlin | `.java`, `.kt .kts` | `jdtls`, `kotlin-ls` |
| Vue, Svelte, Astro | `.vue`, `.svelte`, `.astro` | `vue`, `svelte`, `astro` |
| Ruby, Elixir, Zig, C#, F#, Swift | | `ruby-lsp`, `elixir-ls`, `zls`, `csharp`, `fsharp`, `sourcekit-lsp` |
| Shell, YAML, Lua, and more | | `bash`, `yaml-ls`, `lua-ls`, ... |

Additional built-in server definitions that no language uses by default include `ruff`, `basedpyright`, `ty`, `eslint`, `oxlint`, `biome`, and `deno`; route a language to them as in the examples. `lsp.status` prints the complete effective list. The full schema and merge rules are also documented in the [runtime README](../packages/lsp-tools-mcp/README.md#configuration).
