import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type IsolatedContext, isolatedContext } from "../support/context.js";
import { CLI_PATH } from "../support/repo.js";

const contexts: IsolatedContext[] = [];

afterEach(() => {
	for (const context of contexts.splice(0)) context.cleanup();
});

function context(extra: Record<string, string> = {}): IsolatedContext {
	const created = isolatedContext("codex-lsp-capture", extra);
	contexts.push(created);
	return created;
}

describe("env capture", () => {
	it("#given a shell id #when capturing a command environment #then it gets its own id with the shell as parent", () => {
		// given
		const { env, stateDir } = context({ CODEX_LSP_CONTEXT_ID: "env-shell-parent", VIRTUAL_ENV: "/envs/b" });

		// when
		const result = spawnSync(process.execPath, [CLI_PATH, "env", "capture", "--kind", "command"], {
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
		// when
		const result = spawnSync(process.execPath, [CLI_PATH, "env", "capture", "--kind", "shell"], {
			env: context().env,
			encoding: "utf8",
		});

		// then
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("CODEX_LSP_CONTEXT_ID is not set");
	});
});
