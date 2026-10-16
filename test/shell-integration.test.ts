import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { REPO_ROOT, requireBuiltCli } from "./helpers/stdio.js";

const CLI = join(REPO_ROOT, "dist", "cli.js");
const roots: string[] = [];

beforeAll(requireBuiltCli);

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function has(command: string): boolean {
	return spawnSync(command, ["-c", "exit 0"]).status === 0;
}

interface Snapshot {
	readonly generation: number;
	readonly kind: string;
	readonly variables: Record<string, string>;
	readonly removed: readonly string[];
	readonly shell: { readonly name: string };
}

function snapshots(stateDir: string): Snapshot[] {
	const environments = join(stateDir, "environments");
	const [id, ...others] = readdirSync(environments);
	expect(others).toEqual([]);
	if (id === undefined) throw new Error("no environment captured");
	return readdirSync(join(environments, id))
		.filter((name) => name.startsWith("gen-"))
		.map((name) => JSON.parse(readFileSync(join(environments, id, name), "utf8")) as Snapshot)
		.sort((a, b) => a.generation - b.generation);
}

/** Runs commands in an interactive shell (prompts run between them) with the integration installed. */
function interactive(shell: "bash" | "zsh", priorHook: string, commands: readonly string[], config?: unknown) {
	const stateDir = mkdtempSync(join(tmpdir(), "codex-lsp-shell-"));
	roots.push(stateDir);
	const configPath = join(stateDir, "config.json");
	writeFileSync(configPath, JSON.stringify(config ?? { schemaVersion: 1 }));
	const args = shell === "bash" ? ["--noprofile", "--norc", "-i"] : ["-f", "-i"];
	const { VIRTUAL_ENV: _active, ...env } = process.env;
	const result = spawnSync(shell, args, {
		input: [
			priorHook,
			`eval "$(${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} env shell-init ${shell})"`,
			...commands,
			"exit",
			"",
		].join("\n"),
		env: { ...env, CODEX_LSP_STATE_DIR: stateDir, LSP_TOOLS_MCP_PROJECT_CONFIG: configPath, PS1: "", PROMPT: "" },
		encoding: "utf8",
		timeout: 60_000,
	});
	return { stateDir, output: `${result.stdout}${result.stderr}` };
}

const PRIOR_HOOK = { bash: "PROMPT_COMMAND='echo prior-hook'", zsh: "precmd() { echo prior-hook }" } as const;

describe.each(["bash", "zsh"] as const)("%s integration", (shell) => {
	it.runIf(process.platform !== "win32" && has(shell))(
		"#given invalid config #when repaired without environment changes #then a later prompt captures it",
		() => {
			const config = JSON.stringify({ schemaVersion: 1 });
			const { stateDir, output } = interactive(
				shell,
				PRIOR_HOOK[shell],
				[`printf '%s' '${config}' > "$LSP_TOOLS_MCP_PROJECT_CONFIG"`, "true"],
				{ schemaVersion: 999 },
			);
			expect(output).toContain("environment capture failed");
			expect(snapshots(stateDir)).toHaveLength(1);
		},
	);

	it.runIf(process.platform !== "win32" && has(shell))(
		"#given an extra variable #when only it changes #then the snapshot follows it",
		() => {
			const { stateDir, output } = interactive(
				shell,
				PRIOR_HOOK[shell],
				["export CODEX_LSP_TEST_EXTRA=one", "export CODEX_LSP_TEST_EXTRA=two", "unset CODEX_LSP_TEST_EXTRA"],
				{ schemaVersion: 1, environment: { extraVariables: ["CODEX_LSP_TEST_EXTRA"] } },
			);
			expect(output).not.toContain("capture failed");
			expect(snapshots(stateDir).map((item) => item.variables["CODEX_LSP_TEST_EXTRA"] ?? null)).toEqual([
				"one",
				"two",
				null,
			]);
		},
	);

	// Git Bash on Windows is not a supported integration target.
	it.runIf(process.platform !== "win32" && has(shell))(
		"#given an activated and then deactivated venv #when prompts run #then each change is one generation and the shell is untouched",
		() => {
			// when
			const { stateDir, output } = interactive(shell, PRIOR_HOOK[shell], [
				"export VIRTUAL_ENV=/envs/a",
				"true",
				"unset VIRTUAL_ENV",
				"false",
				'echo "status=$?"',
			]);

			// then
			const generations = snapshots(stateDir);
			expect(generations.map((snapshot) => snapshot.variables["VIRTUAL_ENV"] ?? null)).toEqual([
				null,
				"/envs/a",
				null,
			]);
			expect(generations[2]?.removed).toContain("VIRTUAL_ENV");
			expect(generations.every((snapshot) => snapshot.kind === "shell" && snapshot.shell.name === shell)).toBe(true);
			expect(output).toContain("status=1");
			expect(output).toContain("prior-hook");
			expect(output).not.toContain("capture failed");
		},
	);
});

describe("pwsh integration", () => {
	it.runIf(has("pwsh") || process.env["CODEX_LSP_REQUIRE_PWSH"] === "1")(
		"#given an activated and then deactivated venv #when the prompt runs #then each change is one generation and LASTEXITCODE survives",
		() => {
			// given
			if (!has("pwsh")) throw new Error("PowerShell is required for this CI job but pwsh is unavailable");
			const stateDir = mkdtempSync(join(tmpdir(), "codex-lsp-pwsh-"));
			roots.push(stateDir);
			const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
			const script = [
				`Invoke-Expression ((& ${quote(process.execPath)} ${quote(CLI)} env shell-init pwsh) -join [Environment]::NewLine)`,
				"$null = prompt",
				"$env:VIRTUAL_ENV = '/envs/a'",
				"$null = prompt",
				"$null = prompt",
				"Remove-Item Env:VIRTUAL_ENV",
				"$global:LASTEXITCODE = 3",
				"$null = prompt",
				'Write-Output "code=$LASTEXITCODE"',
			].join("\n");
			const { VIRTUAL_ENV: _active, ...env } = process.env;

			// when
			const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
				input: script,
				env: { ...env, CODEX_LSP_STATE_DIR: stateDir },
				encoding: "utf8",
				timeout: 60_000,
			});

			// then
			expect(result.stdout).toContain("code=3");
			const generations = snapshots(stateDir);
			expect(generations.map((snapshot) => snapshot.variables["VIRTUAL_ENV"] ?? null)).toEqual([
				null,
				"/envs/a",
				null,
			]);
			expect(generations.every((snapshot) => snapshot.shell.name === "pwsh")).toBe(true);
		},
	);
});

describe("env capture", () => {
	it("#given a shell id #when capturing a command environment #then it gets its own id with the shell as parent", () => {
		// given
		const stateDir = mkdtempSync(join(tmpdir(), "codex-lsp-capture-"));
		roots.push(stateDir);
		const env = {
			...process.env,
			CODEX_LSP_STATE_DIR: stateDir,
			CODEX_LSP_CONTEXT_ID: "env-shell-parent",
			VIRTUAL_ENV: "/envs/b",
		};

		// when
		const result = spawnSync(process.execPath, [CLI, "env", "capture", "--kind", "command"], {
			env,
			encoding: "utf8",
		});

		// then
		expect(result.status).toBe(0);
		const id = result.stdout.trim();
		expect(id).toMatch(/^env-[0-9a-f-]{36}$/);
		const manifest = JSON.parse(readFileSync(join(stateDir, "environments", id, "manifest.json"), "utf8"));
		expect(manifest).toMatchObject({ kind: "command", parentEnvironmentId: "env-shell-parent", generation: 1 });
		expect(existsSync(join(stateDir, "environments", "env-shell-parent"))).toBe(false);
	});

	it("#given no shell integration #when capturing a shell environment #then it fails instead of inventing an id", () => {
		// given
		const { CODEX_LSP_CONTEXT_ID: _id, ...env } = process.env;

		// when
		const result = spawnSync(process.execPath, [CLI, "env", "capture", "--kind", "shell"], {
			env: { ...env, CODEX_LSP_STATE_DIR: tmpdir() },
			encoding: "utf8",
		});

		// then
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("CODEX_LSP_CONTEXT_ID is not set");
	});
});
