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

Replacing a server replaces its whole definition, including built-in initialization options and, for `typescript`, the [backend selection](#typescript-backend-selection): a configured `typescript` runs exactly its own command. If you redefine it around typescript-language-server, keep `"initializationOptions": { "tsserver": { "useSyntaxServer": "never" } }`; without it, first requests return single-file results while the project loads.

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
| TypeScript, JavaScript | `.ts .tsx .mts .cts`, `.js .jsx .mjs .cjs` | `typescript` (chosen from the project's SDK; see [below](#typescript-backend-selection)) |
| Python | `.py .pyi` | `pyright` (`pyright-langserver --stdio`) |
| Go | `.go` | `gopls` |
| Rust | `.rs` | `rust` (`rust-analyzer`) |
| C, C++ | `.c .cc .cpp .cxx .h .hpp` and similar | `clangd` (`clangd --background-index --clang-tidy`) |
| Java, Kotlin | `.java`, `.kt .kts` | `jdtls`, `kotlin-ls` |
| Vue, Svelte, Astro | `.vue`, `.svelte`, `.astro` | `vue`, `svelte`, `astro` |
| Ruby, Elixir, Zig, C#, F#, Swift | | `ruby-lsp`, `elixir-ls`, `zls`, `csharp`, `fsharp`, `sourcekit-lsp` |
| Shell, YAML, Lua, and more | | `bash`, `yaml-ls`, `lua-ls`, ... |

Additional built-in server definitions that no language uses by default include `ruff`, `basedpyright`, `ty`, `eslint`, `oxlint`, `biome`, and `deno`; route a language to them as in the examples. `lsp.status` prints the complete effective list. The [schema](../src/core/config/schema.ts) and [configuration loader](../src/core/config/loader.ts) define validation and merge behavior.

## TypeScript backend selection

The built-in `typescript` server picks its backend from the SDK the file's project actually installed: the nearest `node_modules/typescript` from the project root (found with `rootMarkers`) up to the workspace root. Declared version ranges in `package.json`, global installations, and packages under other names (such as an `npm:` alias) are not consulted.

| Installed SDK | Launch |
|---------------|--------|
| Major version below 7 with `lib/tsserver.js` | `typescript-language-server --stdio` with `initializationOptions.tsserver.path` set to that `tsserver.js` and `useSyntaxServer: "never"` |
| 7.x with a `bin.tsc` entry in its `package.json` | `node <sdk>/bin/tsc --lsp --stdio`, using `node` from the bound environment; `typescript-language-server` is not needed |
| None, an unreadable `package.json`, a missing entry, another package name, or another major version | `environment_error` naming the SDK path and the reason |

The decision is made before a server starts. A failed launch is reported as is: another backend or SDK is never tried in its place, a broken SDK is not skipped in favour of one further up, and nothing is installed. TypeScript 7 resolves its platform program (`@typescript/typescript-<platform>-<arch>`) when it starts; when that package is missing the start failure says so.

Each sub-project of a monorepo gets its own choice, so one workspace can run TypeScript 6 and 7 side by side; directory diagnostics check each file with its own project's server. Installing, upgrading, or replacing the SDK is noticed on the next call, and the client for the old backend is replaced. `lsp.status` with `filePath` shows the backend, command, and SDK a file gets without starting a server.

To run something else, define the server yourself. A project or user definition named `typescript` replaces the built-in one, or route the languages to a server with another id:

```json
{
	"schemaVersion": 1,
	"servers": {
		"typescript7": {
			"command": ["node", "/absolute/project/node_modules/typescript/bin/tsc", "--lsp", "--stdio"],
			"rootMarkers": ["tsconfig.json", "jsconfig.json", "package.json"]
		}
	},
	"languages": {
		"typescript": { "semanticServer": "typescript7", "diagnosticServers": ["typescript7"] },
		"javascript": { "semanticServer": "typescript7", "diagnosticServers": ["typescript7"] }
	}
}
```

Use an absolute compiler path in such a definition so monorepo root selection does not change which installation runs. Asking for `server: "typescript"` explicitly still uses the built-in selection while it is not redefined. The real integration suite runs TypeScript 6 and 7 without any route configuration (diagnostics after edits, navigation, rename, call hierarchy, mixed sub-projects, and the edit hooks); versions below 6 follow the same `lib/tsserver.js` rule but are not run against a real server. The native entry flags are defined in [Microsoft's LSP entry](https://github.com/microsoft/typescript-go/blob/main/cmd/tsgo/lsp.go).
