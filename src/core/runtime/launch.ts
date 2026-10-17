import type { EffectiveServer } from "../config/loader.js";
import type { EnvironmentContext } from "../environment/service.js";
import type { ToolchainResolution } from "../environment/toolchains/index.js";
import type { ServerLaunch } from "../lsp/client.js";
import { findExecutable } from "../lsp/command.js";
import { ToolFailure } from "../tools/failures.js";

/** The process a server definition resolves to for one file's project and environment. */
export interface LaunchPlan {
	readonly launch: ServerLaunch;
	readonly executable: string;
	readonly args: readonly string[];
	readonly initializationOptions: Readonly<Record<string, unknown>> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merges `override` onto `base`; nested objects merge, everything else is replaced. */
export function mergeSettings(
	base: Readonly<Record<string, unknown>>,
	override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		result[key] = isRecord(current) && isRecord(value) ? mergeSettings(current, value) : value;
	}
	return result;
}

/** The definition's own executable on the environment's PATH; a missing one is `server_not_installed`. */
function commandExecutable(
	server: EffectiveServer,
	environment: EnvironmentContext,
	workspaceRoot: string | undefined,
): string {
	const command = server.command[0];
	const executable = command === undefined ? undefined : findExecutable(command, environment.variables, workspaceRoot);
	if (executable !== undefined) return executable;
	const hint = server.installHint ? `\nInstall: ${server.installHint}` : "";
	throw new ToolFailure(
		"server_not_installed",
		`LSP server '${server.id}' is not installed in this environment: '${command}' was not found (${environment.source} PATH).${hint}`,
	);
}

/** Runs the definition's command as written. */
export function configuredLaunch(
	server: EffectiveServer,
	environment: EnvironmentContext,
	workspaceRoot: string | undefined,
): LaunchPlan {
	return {
		launch: { backend: "configured", reason: `${server.source} definition of '${server.id}'` },
		executable: commandExecutable(server, environment, workspaceRoot),
		args: server.command.slice(1),
		initializationOptions: server.initializationOptions,
	};
}

/**
 * Chooses the built-in TypeScript backend from the SDK the project actually installed: typescript-language-server
 * pinned to that SDK's tsserver below 7, the SDK's own native LSP for 7. A missing or unusable SDK is an error;
 * no other SDK is borrowed and no backend is tried after another fails.
 */
export function typescriptLaunch(
	server: EffectiveServer,
	node: ToolchainResolution,
	environment: EnvironmentContext,
	workspaceRoot: string | undefined,
	configPath: string,
): LaunchPlan {
	const sdk = node.typescript;
	const nodeExecutable = node.facts["node"];
	if (sdk === undefined || nodeExecutable == null) {
		throw new ToolFailure("internal_error", "The Node toolchain did not report the project's TypeScript SDK.");
	}
	const explicit = `or define the '${server.id}' server explicitly in ${configPath}`;
	if (sdk.status === "missing") {
		throw new ToolFailure(
			"environment_error",
			`No TypeScript SDK was found for the built-in '${server.id}' server (looked for ${sdk.searched.join(", ")}). ` +
				`Install typescript in the project, ${explicit}.`,
		);
	}
	if (sdk.status === "invalid") {
		throw new ToolFailure(
			"environment_error",
			`The TypeScript SDK at ${sdk.path} cannot be used by the built-in '${server.id}' server: ${sdk.problem}. ` +
				`Reinstall it, ${explicit}.`,
		);
	}
	const origin = `TypeScript ${sdk.version} at ${sdk.path} (project SDK)`;
	if (sdk.backend === "typescript-native") {
		return {
			launch: { backend: sdk.backend, reason: `${origin}: native LSP` },
			executable: nodeExecutable,
			args: [sdk.entry, "--lsp", "--stdio"],
			initializationOptions: undefined,
		};
	}
	return {
		launch: { backend: sdk.backend, reason: `${origin}: typescript-language-server with ${sdk.entry}` },
		executable: commandExecutable(server, environment, workspaceRoot),
		args: server.command.slice(1),
		initializationOptions: mergeSettings(server.initializationOptions ?? {}, { tsserver: { path: sdk.entry } }),
	};
}
