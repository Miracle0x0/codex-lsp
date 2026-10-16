import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EnvironmentService, UNBOUND_NOTE } from "../../src/core/environment/service.js";
import { readManifest, writeSnapshot } from "../../src/core/environment/snapshot.js";
import { ToolFailure } from "../../src/core/tools/failures.js";

let stateDir: string;
const ID = "env-test-0001";

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "lsp-env-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

function capture(env: Record<string, string>) {
	return writeSnapshot(stateDir, {
		environmentId: ID,
		kind: "shell",
		executionContextId: "shell-1",
		cwd: "/work",
		env,
	});
}

describe("environment snapshots", () => {
	it("#given unchanged variables #when the shell moves #then snapshot metadata records the new directory", () => {
		capture({ PATH: "/usr/bin" });
		const next = writeSnapshot(stateDir, {
			environmentId: ID,
			kind: "shell",
			executionContextId: "shell-1",
			cwd: "/other",
			env: { PATH: "/usr/bin" },
		});
		expect(next.snapshot.cwd).toBe("/other");
		expect(next.changed).toBe(true);
	});

	it("#given unchanged variables #when capturing again #then no new generation is written", () => {
		// given
		const first = capture({ PATH: "/venv-a/bin:/usr/bin", VIRTUAL_ENV: "/venv-a" });

		// when
		const second = capture({ PATH: "/venv-a/bin:/usr/bin", VIRTUAL_ENV: "/venv-a", UNRELATED: "ignored" });

		// then
		expect(first.snapshot.generation).toBe(1);
		expect(second.changed).toBe(false);
		expect(readManifest(stateDir, ID)?.generation).toBe(1);
		expect(first.snapshot.variables).not.toHaveProperty("UNRELATED");
	});

	it("#given a deactivated venv #when resolving the new generation #then the removed variable does not survive from the process env", () => {
		// given
		capture({ PATH: "/venv-a/bin:/usr/bin", VIRTUAL_ENV: "/venv-a" });
		const deactivated = capture({ PATH: "/usr/bin" });
		const service = new EnvironmentService({
			stateDir,
			processEnv: { PATH: "/mcp/bin", VIRTUAL_ENV: "/stale", HOME: "/home/u" },
		});

		// when
		const context = service.resolve(ID, "active-shell");

		// then
		expect(deactivated.snapshot.generation).toBe(2);
		expect(deactivated.snapshot.removed).toContain("VIRTUAL_ENV");
		expect(context).toMatchObject({ environmentId: ID, generation: 2, source: "shell-snapshot", key: `${ID}#2` });
		expect(context.variables["PATH"]).toBe("/usr/bin");
		expect(context.variables).not.toHaveProperty("VIRTUAL_ENV");
	});

	it("#given no binding #when resolving in active-shell mode #then the process environment is used and reported as unbound", () => {
		// given
		const service = new EnvironmentService({ stateDir, processEnv: { PATH: "/mcp/bin" } });

		// when
		const context = service.resolve(undefined, "active-shell");

		// then
		expect(context).toMatchObject({ environmentId: null, source: "unbound", notes: [UNBOUND_NOTE] });
		expect(context.variables["PATH"]).toBe("/mcp/bin");
	});

	it("#given an environment id without a snapshot #when resolving #then it fails instead of falling back", () => {
		// given
		const service = new EnvironmentService({ stateDir });

		// when
		const resolve = () => service.resolve("env-missing-01", "active-shell");

		// then
		expect(resolve).toThrow(ToolFailure);
		expect(resolve).toThrow(/has no captured snapshot/);
	});
});
