import { basename, dirname, isAbsolute, normalize } from "node:path";

import { defaultStateDir, ENVIRONMENT_ID_PATTERN } from "@code-yeongyu/lsp-tools-mcp";

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
	readonly warnings: readonly string[];
}

/**
 * Reads the launcher's binding. The manifest lives at `<stateDir>/environments/<id>/manifest.json`, so it
 * also names the state directory; a manifest that does not fit that layout or the id is rejected.
 */
export function launchBinding(env: NodeJS.ProcessEnv): LaunchBinding {
	const fallback = captureStateDir(env);
	const id = env[CONTEXT_ID_ENV];
	const manifest = env[MANIFEST_ENV];
	if (id === undefined || id === "") return { stateDir: fallback, environmentId: undefined, warnings: [] };
	if (!ENVIRONMENT_ID_PATTERN.test(id)) {
		return { stateDir: fallback, environmentId: undefined, warnings: [`ignoring invalid ${CONTEXT_ID_ENV}`] };
	}
	if (manifest === undefined || manifest === "") return { stateDir: fallback, environmentId: id, warnings: [] };
	const path = normalize(manifest);
	const environmentDir = dirname(path);
	const environments = dirname(environmentDir);
	if (
		!isAbsolute(path) ||
		basename(path) !== "manifest.json" ||
		basename(environmentDir) !== id ||
		basename(environments) !== "environments"
	) {
		return {
			stateDir: fallback,
			environmentId: undefined,
			warnings: [`ignoring ${CONTEXT_ID_ENV}: ${MANIFEST_ENV} is not <stateDir>/environments/${id}/manifest.json`],
		};
	}
	return { stateDir: dirname(environments), environmentId: id, warnings: [] };
}
