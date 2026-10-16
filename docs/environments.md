# Shell environments

codex-lsp analyzes code with the language environment of the shell you work in: an activated venv, a uv project environment, a Conda env, the Node version a version manager selected, a Go or Rust toolchain. A process cannot read another shell's variables, so the shell hands them over through a snapshot. Without one, `lsp.status` reports the environment as `unbound` and the language servers run with the MCP process's own environment.

## Launch Codex from your shell (recommended)

Run `codex-lsp launch` instead of `codex`, from the shell whose environment should be used:

```bash
source .venv/bin/activate
node /path/to/codex-lsp/dist/cli.js launch            # interactive session
node /path/to/codex-lsp/dist/cli.js launch -- exec "fix the failing test"
```

Arguments after `launch` (an optional `--` first) go to `codex`. The launcher:

1. captures a snapshot of this shell's environment (a new environment id, kind `launch`);
2. starts `codex --no-daemon ...` with `CODEX_LSP_CONTEXT_ID` and `CODEX_LSP_ENV_MANIFEST` set;
3. exits with Codex's exit code.

The plugin's MCP server receives those two variables (they are forwarded in `.mcp.json`) and uses the snapshot for every call. `--no-daemon` matters: a shared Codex background server would keep the environment it started with.

An alias saves typing:

```bash
alias cx='node /path/to/codex-lsp/dist/cli.js launch'
```

If the package is installed from npm, the command is `codex-lsp launch`.

## Shell integration

The shell integration keeps a snapshot of an interactive shell current while you work. Add one line to your shell's startup file:

```bash
# ~/.bashrc
eval "$(node /path/to/codex-lsp/dist/cli.js env shell-init bash)"

# ~/.zshrc
eval "$(node /path/to/codex-lsp/dist/cli.js env shell-init zsh)"
```

```powershell
# $PROFILE
Invoke-Expression ((& node /path/to/codex-lsp/dist/cli.js env shell-init pwsh) -join [Environment]::NewLine)
```

Each interactive shell gets its own environment id (exported as `CODEX_LSP_CONTEXT_ID`; nested shells get a new one). Before each prompt, the integration compares the working directory and the language-related variables with the last capture and, only when something changed, records a new generation. Activating or deactivating a venv therefore produces a new generation at the next prompt, and variables you unset are recorded as removed. Existing `PROMPT_COMMAND`, `precmd` hooks, and `prompt` functions keep running, and `$?` / `$LASTEXITCODE` are preserved.

With the integration installed, `codex-lsp launch` records the shell's id as the parent of the launch snapshot.

## Desktop app, IDE, or a shared Codex daemon

These hosts do not start from your shell. Bind them explicitly to a shell's environment id:

1. In a shell with the integration installed, note the id: `echo $CODEX_LSP_CONTEXT_ID`.
2. Print a configuration pinned to it and add it to `~/.codex/config.toml` yourself:

   ```bash
   node /path/to/codex-lsp/dist/cli.js config mcp --environment-id "$CODEX_LSP_CONTEXT_ID"
   ```

The MCP server reads the latest generation of that id on every call, so the host follows activations you make later in that shell. The command refuses ids that were never captured. This path is supported by design but has not been verified against the Codex desktop app.

## Command-scoped environments

To analyze with an environment that exists only inside one command, capture it in the same command and pass the printed id to tools as `environmentId`:

```bash
source envs/py311/bin/activate && node /path/to/codex-lsp/dist/cli.js env capture --kind command
# prints e.g. env-6f1c...; then: lsp.diagnostics { "filePath": "app.py", "environmentId": "env-6f1c..." }
```

A command capture gets its own id and never changes the shell's or the session's default environment. The plugin's skill tells Codex how to do this when it activates environments itself.

## What gets captured and where

Snapshots record only the variables language tooling reads, for example `PATH`, `HOME`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `UV_PROJECT_ENVIRONMENT`, `PYTHONPATH`, `NODE_OPTIONS`, `GOROOT`, `GOFLAGS`, `RUSTUP_TOOLCHAIN`, `CARGO_HOME`, `JAVA_HOME`, `CC`, and `CXX`. A project can add variables with `environment.extraVariables` (see [Configuration](configuration.md)). Full environments are never written, and nothing is sent to the model.

| Platform | State directory |
|----------|-----------------|
| Linux, macOS | `$XDG_STATE_HOME/codex-lsp`, else `~/.local/state/codex-lsp` |
| Windows | `%LOCALAPPDATA%\codex-lsp` |

Set `CODEX_LSP_STATE_DIR` to an absolute path to use another directory. Each environment is `environments/<id>/manifest.json` plus the last three `gen-<n>.json` snapshots; directories are created with mode `0700` and files with `0600`.

## How the toolchain is chosen

For each file, the runtime resolves the language's toolchain from the bound snapshot and reports it in `lsp.status` with `filePath`:

| Toolchain | Resolution |
|-----------|------------|
| Python | The `python` (or `python3`) first on the snapshot's `PATH`, which is what activation selects. The interpreter reports its own `sys.executable`, `prefix`, `base_prefix`, and version, and Pyright gets it as `python.pythonPath`. The result must agree with `VIRTUAL_ENV` (a venv inside Conda wins over `CONDA_PREFIX`) or `CONDA_PREFIX`; a disagreement or a missing venv directory fails the run instead of using another Python. A project `.venv` or `UV_PROJECT_ENVIRONMENT` that is not active is mentioned as a note. `environment.python.interpreter` pins an interpreter explicitly. |
| Node / TypeScript | `node` from the snapshot's `PATH`, and the project's own `typescript` package; the plugin never lends its own TypeScript. |
| Go | `go env` with `GOTOOLCHAIN=local`, so probing never downloads a toolchain. |
| Rust | `rustc` and `cargo` with `RUSTUP_AUTO_INSTALL=0`. |
| Java | `java -version` from the snapshot's `JAVA_HOME` or `PATH`. |
| C/C++ | Versions of `$CC` and `$CXX`, and the compile database clangd will use (`compile_commands.json` or `compile_flags.txt` in the project or its `build`, `out`, `cmake-build-*` directories); a missing database is reported as a note. |

Probing runs the tools without a shell, with a timeout, from an empty private directory. It never installs anything.

When an environment gets a new generation, clients started for the old one are replaced, so cached results from the previous environment are not reused.
