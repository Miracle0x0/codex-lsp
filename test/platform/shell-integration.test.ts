import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { type IsolatedContext, isolatedContext } from "../support/context.js";
import { CLI_PATH } from "../support/repo.js";
import { describeWithTools } from "../support/tools.js";

const contexts: IsolatedContext[] = [];

afterEach(() => {
	for (const context of contexts.splice(0)) context.cleanup();
});

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
	const context = isolatedContext("codex-lsp-shell");
	contexts.push(context);
	const configPath = join(context.root, "config.json");
	writeFileSync(configPath, JSON.stringify(config ?? { schemaVersion: 1 }));
	const args = shell === "bash" ? ["--noprofile", "--norc", "-i"] : ["-f", "-i"];
	const result = spawnSync(shell, args, {
		input: [
			priorHook,
			`eval "$(${JSON.stringify(process.execPath)} ${JSON.stringify(CLI_PATH)} env shell-init ${shell})"`,
			...commands,
			"exit",
			"",
		].join("\n"),
		env: { ...context.env, LSP_TOOLS_MCP_PROJECT_CONFIG: configPath, PS1: "", PROMPT: "" },
		encoding: "utf8",
		timeout: 60_000,
	});
	return { stateDir: context.stateDir, output: `${result.stdout}${result.stderr}` };
}

const PRIOR_HOOK = { bash: "PROMPT_COMMAND='echo prior-hook'", zsh: "precmd() { echo prior-hook }" } as const;

// Git Bash on Windows is not a supported integration target, so bash and zsh run on POSIX systems only.
for (const shell of process.platform === "win32" ? [] : (["bash", "zsh"] as const)) {
	describeWithTools(`${shell} integration`, [shell], () => {
		it("#given invalid config #when repaired without environment changes #then a later prompt captures it", () => {
			const config = JSON.stringify({ schemaVersion: 1 });
			const { stateDir, output } = interactive(
				shell,
				PRIOR_HOOK[shell],
				[`printf '%s' '${config}' > "$LSP_TOOLS_MCP_PROJECT_CONFIG"`, "true"],
				{ schemaVersion: 999 },
			);
			expect(output).toContain("environment capture failed");
			expect(snapshots(stateDir)).toHaveLength(1);
		});

		it("#given an extra variable #when only it changes #then the snapshot follows it", () => {
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
		});

		it("#given an activated and then deactivated venv #when prompts run #then each change is one generation and the shell is untouched", () => {
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
		});
	});
}

describeWithTools("pwsh integration", ["pwsh"], () => {
	it("#given an activated and then deactivated venv #when the prompt runs #then each change is one generation and LASTEXITCODE survives", () => {
		// given
		const context = isolatedContext("codex-lsp-pwsh");
		contexts.push(context);
		const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
		const script = [
			`Invoke-Expression ((& ${quote(process.execPath)} ${quote(CLI_PATH)} env shell-init pwsh) -join [Environment]::NewLine)`,
			"$null = prompt",
			"$env:VIRTUAL_ENV = '/envs/a'",
			"$null = prompt",
			"$null = prompt",
			"Remove-Item Env:VIRTUAL_ENV",
			"$global:LASTEXITCODE = 3",
			"$null = prompt",
			'Write-Output "code=$LASTEXITCODE"',
		].join("\n");

		// when
		const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
			input: script,
			env: context.env,
			encoding: "utf8",
			timeout: 60_000,
		});

		// then
		expect(result.stdout).toContain("code=3");
		const generations = snapshots(context.stateDir);
		expect(generations.map((snapshot) => snapshot.variables["VIRTUAL_ENV"] ?? null)).toEqual([null, "/envs/a", null]);
		expect(generations.every((snapshot) => snapshot.shell.name === "pwsh")).toBe(true);
	});
});
