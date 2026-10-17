import { basename, dirname, isAbsolute, normalize } from "node:path";

import { defaultStateDir, ENVIRONMENT_ID_PATTERN } from "../../core/index.js";

/** Variables the launcher exports and `.mcp.json` forwards to the MCP process. */
export const CONTEXT_ID_ENV = "CODEX_LSP_CONTEXT_ID";
export const MANIFEST_ENV = "CODEX_LSP_ENV_MANIFEST";
export const STATE_DIR_ENV = "CODEX_LSP_STATE_DIR";

/** Where captures are written: `CODEX_LSP_STATE_DIR`, else the platform state directory. */
export function captureStateDir(env: NodeJS.ProcessEnv): string {
	return defaultStateDir("codex-lsp", STATE_DIR_ENV, env);
}

export interface LaunchBinding {
	readonly stateDir: string;
	/** Environment captured by the launcher for this Codex process; undefined when none is bound. */
	readonly environmentId: string | undefined;
	/**
	 * Why a binding the launcher passed cannot be used. Calls that would use it must fail with this instead of
	 * quietly analyzing code in the MCP process's own environment.
	 */
	readonly problem: string | undefined;
}

const RELAUNCH = "start Codex again with 'codex-lsp launch'";

/**
 * Reads the launcher's binding. The manifest lives at `<stateDir>/environments/<id>/manifest.json`, so it
 * also names the state directory; a manifest that does not fit that layout or the id is rejected.
 */
export function launchBinding(env: NodeJS.ProcessEnv): LaunchBinding {
	const fallback = captureStateDir(env);
	const id = env[CONTEXT_ID_ENV];
	const manifest = env[MANIFEST_ENV];
	const unusable = (reason: string): LaunchBinding => ({
		stateDir: fallback,
		environmentId: undefined,
		problem: `the launcher's environment binding is unusable: ${reason}; ${RELAUNCH}`,
	});
	if (id === undefined || id === "") return { stateDir: fallback, environmentId: undefined, problem: undefined };
	if (!ENVIRONMENT_ID_PATTERN.test(id)) return unusable(`${CONTEXT_ID_ENV} is not a valid environment id`);
	if (manifest === undefined || manifest === "") return { stateDir: fallback, environmentId: id, problem: undefined };
	const path = normalize(manifest);
	const environmentDir = dirname(path);
	const environments = dirname(environmentDir);
	if (
		!isAbsolute(path) ||
		basename(path) !== "manifest.json" ||
		basename(environmentDir) !== id ||
		basename(environments) !== "environments"
	) {
		return unusable(`${MANIFEST_ENV} is not <stateDir>/environments/${id}/manifest.json`);
	}
	return { stateDir: dirname(environments), environmentId: id, problem: undefined };
}
