import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchBinding } from "../../src/codex/environment/binding.js";

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
		expect(launchBinding(env)).toEqual({ stateDir: STATE, environmentId: ID, warnings: [] });
	});

	it("#given no binding #when reading #then nothing is bound and the default state directory is used", () => {
		expect(launchBinding({ CODEX_LSP_STATE_DIR: STATE })).toEqual({
			stateDir: STATE,
			environmentId: undefined,
			warnings: [],
		});
	});

	it("#given an invalid id or a manifest for another id #when reading #then the binding is refused with a warning", () => {
		// given
		const invalid = launchBinding({ CODEX_LSP_CONTEXT_ID: "../../etc", CODEX_LSP_STATE_DIR: STATE });
		const mismatched = launchBinding({
			CODEX_LSP_CONTEXT_ID: ID,
			CODEX_LSP_ENV_MANIFEST: join(STATE, "environments", "env-other-0002", "manifest.json"),
			CODEX_LSP_STATE_DIR: STATE,
		});

		// then
		expect(invalid.environmentId).toBeUndefined();
		expect(invalid.warnings[0]).toContain("invalid CODEX_LSP_CONTEXT_ID");
		expect(mismatched.environmentId).toBeUndefined();
		expect(mismatched.warnings[0]).toContain("is not");
	});
});
