import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchBinding } from "../../src/codex/environment/binding.js";
import { createLspRuntime } from "../../src/core/index.js";
import { isolatedContext } from "../support/context.js";

const STATE = "/state/codex-lsp";
const ID = "env-launch-0001";

describe("launch environment binding", () => {
	it("#given the launcher's id and manifest #when reading #then the state directory comes from the manifest path", () => {
		// given
		const env = {
			CODEX_LSP_CONTEXT_ID: ID,
			CODEX_LSP_ENV_MANIFEST: join(STATE, "environments", ID, "manifest.json"),
		};

		// when / then
		expect(launchBinding(env)).toEqual({ stateDir: STATE, environmentId: ID, problem: undefined });
	});

	it("#given no binding #when reading #then nothing is bound and the default state directory is used", () => {
		expect(launchBinding({ CODEX_LSP_STATE_DIR: STATE })).toEqual({
			stateDir: STATE,
			environmentId: undefined,
			problem: undefined,
		});
	});

	it("#given an invalid id or a manifest for another id #when reading #then nothing is bound and the problem is reported", () => {
		// given
		const invalid = launchBinding({ CODEX_LSP_CONTEXT_ID: "../../etc", CODEX_LSP_STATE_DIR: STATE });
		const mismatched = launchBinding({
			CODEX_LSP_CONTEXT_ID: ID,
			CODEX_LSP_ENV_MANIFEST: join(STATE, "environments", "env-other-0002", "manifest.json"),
			CODEX_LSP_STATE_DIR: STATE,
		});

		// then
		expect(invalid.environmentId).toBeUndefined();
		expect(invalid.problem).toContain("CODEX_LSP_CONTEXT_ID is not a valid environment id");
		expect(mismatched.environmentId).toBeUndefined();
		expect(mismatched.problem).toContain("CODEX_LSP_ENV_MANIFEST is not");
	});
});

describe("runtime default environment", () => {
	it("#given an unusable default binding #when a call names its own environment #then that one is used, otherwise the call fails", async () => {
		// given
		const context = isolatedContext("lsp-binding");
		const runtime = createLspRuntime({ config: context.config, defaultEnvironmentError: "binding is unusable" });
		const call = { signal: new AbortController().signal };

		try {
			// when / then
			expect(runtime.environmentId({ environmentId: "env-named-0001" }, call)).toBe("env-named-0001");
			expect(runtime.environmentId({}, { ...call, environmentId: "env-host-0001" })).toBe("env-host-0001");
			expect(() => runtime.environmentId({}, call)).toThrow("binding is unusable");
		} finally {
			await runtime.dispose();
			context.cleanup();
		}
	});
});
