# Adding language server support

There are two ways to support another language server:

- **Configuration** (no code): define the server and route a language to it in `.codex/lsp-client.json`. Use this for one project, one machine, or a server you are trying out.
- **Built-in route** (a change to this repository): ship the definition with the plugin so every project gets it without configuration. Use this for widely used servers with a stable command line.

Either way the server must speak the Language Server Protocol over stdin/stdout. Many servers need a flag for that (`--stdio`, `lsp`, `server`); check the server's own documentation. Push and pull diagnostics are both supported, and a tool the server does not implement fails with `[capability_unsupported]` instead of returning empty results.

## Through configuration

### 1. Make sure the server runs in your environment

Servers are looked up on the `PATH` of the environment the plugin is bound to, not necessarily the shell you are typing in (see [Shell environments](environments.md)). Install the server there and check that it starts, for example `marksman server` waits for input on stdin instead of exiting.

### 2. Define the server and a language

```json
{
	"schemaVersion": 1,
	"servers": {
		"marksman": {
			"command": ["marksman", "server"],
			"rootMarkers": [".marksman.toml", ".git"],
			"installHint": "brew install marksman"
		}
	},
	"languages": {
		"markdown": { "extensions": [".md"], "semanticServer": "marksman", "diagnosticServers": ["marksman"] }
	}
}
```

Put it in `<workspace>/.codex/lsp-client.json` for one project or `~/.codex/lsp-client.json` for all of them. The file is read again on the next tool call; Codex does not need to restart, and changing a server's definition replaces its running client.

Choose the fields deliberately:

| Field | Guidance |
|-------|----------|
| `servers.<id>.command` | A bare name is looked up on the environment's `PATH`; a relative path resolves against the workspace root. Prefer a bare name over an absolute path so the definition works on other machines. |
| `rootMarkers` | Files that mark a project root, such as `Cargo.toml` or `*.csproj` (a `*.ext` pattern matches any file with that extension). The nearest directory above a file that has one becomes the server's root, so monorepo packages get separate servers. Without markers, the workspace root is used. |
| `settings` / `initializationOptions` | Server-specific options, answered to `workspace/configuration` and sent with `initialize`. |
| `env` | Extra variables for the server process only. |
| `languages.<id>.extensions` | Each extension belongs to exactly one language. To add a server for a language that already exists (for example a linter for Python), route the existing language instead of declaring a new one. |
| `languageId` | The LSP language id sent with documents. It defaults to the standard id for the extension; set it when the server expects another one. |
| `toolchain` | One of `python`, `node`, `rust`, `go`, `java`, `cpp`, or `null`. It selects the environment probe whose result `lsp.status` shows and whose settings (such as Pyright's interpreter) are passed to the server. Use `null` when none applies. |
| `semanticServer` / `diagnosticServers` | The server for navigation, hover, call hierarchy, and rename, and the servers whose diagnostics are combined. They can differ, for example a type checker for semantics plus a linter for diagnostics. |

Adding a diagnostic source to an existing language looks like this (arrays replace, so list the existing server too):

```json
{
	"schemaVersion": 1,
	"languages": { "python": { "diagnosticServers": ["pyright", "ruff"] } }
}
```

All fields and merge rules are in [Configuration](configuration.md).

### 3. Check it

1. `lsp.status` with `filePath` set to a file of the language: the file's language, each server's project root and exact command, or the reason it cannot start (`[server_not_installed]`, `[environment_error]`, ...).
2. `lsp.diagnostics` on a file with a deliberate error: the provider should report `status: "ok"` and the error with its `providerId`.
3. `lsp.goto_definition` or `lsp.hover` on a symbol, if the server provides semantics.

An invalid configuration file makes every tool fail with `[config_invalid]`, naming the file and field. See [Troubleshooting](troubleshooting.md) for servers that start but return nothing.

## As a built-in route

A built-in route is the same definition shipped in [builtins.ts](../src/core/config/builtins.ts). User and project configuration can still replace, reroute, or disable it.

### 1. Add the server and the route

In [builtins.ts](../src/core/config/builtins.ts), add the server to `BUILTIN_SERVERS` with a `command`, `rootMarkers`, and an `installHint` that tells users how to install it. Then route a language to it in `BUILTIN_LANGUAGES` with `route(serverId, extensions, toolchain)`. Servers that no language uses by default (alternatives such as `ruff` or `basedpyright`) only need the `BUILTIN_SERVERS` entry; users route to them by id.

If the extension's standard LSP language id is missing from `EXT_TO_LANG` in [language-mappings.ts](../src/core/lsp/language-mappings.ts), add it there; otherwise documents are sent as `plaintext`.

Keep defaults that a server needs for correct results in the definition, with a comment explaining why (the built-in `typescript` server's `useSyntaxServer: "never"` is an example). Do not make a built-in server download or install anything when it starts.

### 2. Reuse or add a toolchain

Reuse an existing toolchain kind when the language belongs to one. Add a new kind only when the server's behaviour depends on an environment that `lsp.status` should report (an interpreter, SDK, or compiler):

1. Add the kind to `TOOLCHAIN_KINDS` in [schema.ts](../src/core/config/schema.ts).
2. Implement a `ToolchainAdapter` in `src/core/environment/toolchains/<kind>.ts` (see [go.ts](../src/core/environment/toolchains/go.ts) for a small example) and register it in `TOOLCHAIN_ADAPTERS` in [index.ts](../src/core/environment/toolchains/index.ts).
3. In the adapter, find executables on the environment's `PATH` with `findExecutable`, run probes with `runProbe` (no shell, with a timeout), and keep probes from downloading or installing toolchains. Return `unavailableToolchain(...)` with a concrete problem when the toolchain cannot be used; never fall back to another installation. Put what was found in `facts`, derive `fingerprint` from it so a changed toolchain replaces running clients, and set `settings` when the server needs them. When the result depends on files in the project, list them in `inputs` so a cached result is dropped as soon as they change.

The toolchain only describes the environment. Choosing a server command from it is the exception, done for TypeScript in [launch.ts](../src/core/runtime/launch.ts); add such logic only when the project's installed SDK decides which program has to run.

### 3. Test it

- **Component tests** (`pnpm test`) need no external tools. Add a case to [config.test.ts](../test/core/config.test.ts) when the route has non-obvious merge or override behaviour, and test a new toolchain adapter's error paths without the real tool where possible.
- **Integration tests** (`pnpm run test:integration`) run the real server. Add `test/integration/<language>.test.ts` following [go.test.ts](../test/integration/go.test.ts): wrap the suite in `describeWithTools("<Language>", ["<executables>"], ...)` so it is skipped with the reason when the server is missing locally, create projects with `createWorkspace()` (a private home and configuration, so your own `.codex/lsp-client.json` cannot hide a broken built-in route), and cover at least:
  - a type error that `diagnostics` reports and that disappears after fixing the file;
  - `goto_definition` or `find_references` across two files;
  - `status` with `filePath`, showing the expected toolchain facts.
- **CI**: add a `suite` entry to the `integration` matrix in [ci.yml](../.github/workflows/ci.yml), an install step with a pinned server version, and a line in "Record tool versions". CI sets `CODEX_LSP_REQUIRE_TOOLS=1`, so a missing tool fails the job instead of skipping it.

### 4. Document it

- [Configuration](configuration.md): the "Built-in routes" table, or the list of additional built-in servers.
- [Installation](installation.md): the requirements table, if the server is common enough to list.
- [Shell environments](environments.md): the "How the toolchain is chosen" table, for a new toolchain kind.
- [CHANGELOG.md](../CHANGELOG.md): an entry under "Unreleased".

Before sending the change, run `pnpm run check`, `pnpm test`, the new integration suite, and `pnpm run test:package`, which verifies the staged plugin outside the source tree.
