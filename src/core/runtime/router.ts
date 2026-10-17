import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { type ConfigService, type EffectiveConfig, type EffectiveLanguage, stableHash } from "../config/loader.js";
import type { ToolchainKind } from "../config/schema.js";
import type { EnvironmentContext, EnvironmentService } from "../environment/service.js";
import { TOOLCHAIN_ADAPTERS, type ToolchainResolution } from "../environment/toolchains/index.js";
import { ancestors, fileStamp } from "../environment/toolchains/types.js";
import type { ServerTarget } from "../lsp/client.js";
import { TOOLCHAIN_CACHE_TTL_MS } from "../lsp/constants.js";
import { getLanguageId } from "../lsp/language-mappings.js";
import { ToolFailure } from "../tools/failures.js";
import { configuredLaunch, mergeSettings, typescriptLaunch } from "./launch.js";

/** One source file resolved against configuration and the call's environment. */
export interface FileTarget {
	readonly path: string;
	readonly uri: string;
	readonly workspaceRoot: string | undefined;
	readonly config: EffectiveConfig;
	readonly language: EffectiveLanguage;
	readonly languageId: string;
	readonly environment: EnvironmentContext;
}

/** The error for an explicit file whose extension no configured language claims. */
export function unconfiguredLanguage(path: string, config: EffectiveConfig): ToolFailure {
	const extension = extname(path);
	return new ToolFailure(
		"server_not_configured",
		`No language is configured for '${extension || path}'. Add it under "languages" in ${config.files.project?.path ?? config.files.user.path}.`,
	);
}

export function isInside(path: string, root: string): boolean {
	const offset = relative(root, path);
	return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function hasMarker(directory: string, marker: string): boolean {
	if (marker.startsWith("*.")) {
		const suffix = marker.slice(1);
		try {
			return readdirSync(directory).some((entry) => entry.endsWith(suffix));
		} catch {
			return false;
		}
	}
	return existsSync(join(directory, marker));
}

/** Nearest directory with one of the markers, bounded by the workspace root when the file is inside it. */
export function findProjectRoot(path: string, markers: readonly string[], workspaceRoot: string | undefined): string {
	const start = dirname(path);
	const bounded = workspaceRoot !== undefined && isInside(path, workspaceRoot) ? workspaceRoot : undefined;
	for (const directory of ancestors(start, bounded)) {
		if (markers.some((marker) => hasMarker(directory, marker))) return directory;
	}
	if (bounded !== undefined) return bounded;
	for (const directory of ancestors(start, undefined)) {
		if (hasMarker(directory, ".git")) return directory;
	}
	return start;
}

interface CachedToolchain {
	readonly at: number;
	readonly promise: Promise<ToolchainResolution>;
	/** Set when the probe finished; its input files decide whether the entry is still current. */
	resolved: ToolchainResolution | undefined;
}

function inputsUnchanged(resolution: ToolchainResolution | undefined): boolean {
	return (resolution?.inputs ?? []).every((input) => fileStamp(input.path) === input.stamp);
}

function requireUsable(toolchain: ToolchainResolution, projectRoot: string): ToolchainResolution {
	if (toolchain.status !== "unavailable") return toolchain;
	throw new ToolFailure(
		"environment_error",
		`${toolchain.kind} toolchain for ${projectRoot} is unavailable [${toolchain.source}]: ${toolchain.problem}`,
	);
}

export class TargetResolver {
	private readonly toolchains = new Map<string, CachedToolchain>();

	constructor(
		private readonly configs: ConfigService,
		private readonly environments: EnvironmentService,
		private readonly now: () => number = () => Date.now(),
	) {}

	config(workspaceRoot: string | undefined): EffectiveConfig {
		return this.configs.load(workspaceRoot);
	}

	environment(config: EffectiveConfig, environmentId: string | undefined): EnvironmentContext {
		return this.environments.resolve(environmentId, config.environment.source);
	}

	file(path: string, workspaceRoot: string | undefined, environmentId: string | undefined): FileTarget {
		const config = this.config(workspaceRoot);
		const target = this.fileTarget(path, workspaceRoot, config, this.environment(config, environmentId));
		if (target === undefined) throw unconfiguredLanguage(path, config);
		return target;
	}

	/** Resolves a file with an already loaded config and environment; undefined when no language claims it. */
	fileTarget(
		path: string,
		workspaceRoot: string | undefined,
		config: EffectiveConfig,
		environment: EnvironmentContext,
	): FileTarget | undefined {
		const extension = extname(path);
		const language = config.languageForExtension(extension);
		if (language === undefined) return undefined;
		return {
			path,
			uri: pathToFileURL(path).href,
			workspaceRoot,
			config,
			language,
			languageId: language.languageId ?? getLanguageId(extension),
			environment,
		};
	}

	semanticServerId(file: FileTarget, requested: string | undefined): string {
		if (requested !== undefined) return requested;
		const { language } = file;
		if (language.semanticServer !== null) return language.semanticServer;
		const disabled = language.disabledServers.length > 0 ? ` (disabled: ${language.disabledServers.join(", ")})` : "";
		throw new ToolFailure(
			"server_not_configured",
			`Language '${language.id}' has no semantic server configured${disabled}.`,
		);
	}

	toolchain(
		kind: ToolchainKind,
		file: FileTarget,
		projectRoot: string,
		signal?: AbortSignal,
	): Promise<ToolchainResolution> {
		const key = [file.environment.key, projectRoot, kind, stableHash(file.config.environment)].join("|");
		const cached = this.toolchains.get(key);
		if (cached !== undefined && this.now() - cached.at < TOOLCHAIN_CACHE_TTL_MS && inputsUnchanged(cached.resolved)) {
			return cached.promise;
		}
		const promise = TOOLCHAIN_ADAPTERS[kind]({
			environment: file.environment,
			projectRoot,
			workspaceRoot: file.workspaceRoot,
			config: file.config.environment,
			...(signal ? { signal } : {}),
		});
		const entry: CachedToolchain = { at: this.now(), promise, resolved: undefined };
		this.toolchains.set(key, entry);
		promise.then(
			(resolution) => {
				entry.resolved = resolution;
			},
			() => {
				if (this.toolchains.get(key) === entry) this.toolchains.delete(key);
			},
		);
		return promise;
	}

	async server(file: FileTarget, serverId: string, signal?: AbortSignal): Promise<ServerTarget> {
		const { config, environment } = file;
		const server = config.servers.get(serverId);
		if (server === undefined) {
			const disabledBy = config.disabledServers.get(serverId);
			throw new ToolFailure(
				"server_not_configured",
				disabledBy
					? `Server '${serverId}' is disabled by the ${disabledBy} config.`
					: `Unknown server '${serverId}'.`,
			);
		}
		const projectRoot = findProjectRoot(file.path, server.rootMarkers, file.workspaceRoot);
		const toolchain = file.language.toolchain
			? requireUsable(await this.toolchain(file.language.toolchain, file, projectRoot, signal), projectRoot)
			: null;
		// The SDK-selected server reads the project's TypeScript SDK from the Node toolchain, whatever the route names.
		const node = !server.sdkSelected
			? null
			: toolchain?.kind === "node"
				? toolchain
				: requireUsable(await this.toolchain("node", file, projectRoot, signal), projectRoot);
		const plan =
			node === null
				? configuredLaunch(server, environment, file.workspaceRoot)
				: typescriptLaunch(
						server,
						node,
						environment,
						file.workspaceRoot,
						config.files.project?.path ?? config.files.user.path,
					);
		const env = { ...environment.variables, ...server.env };
		const slot = [environment.environmentId ?? environment.source, projectRoot, serverId].join("|");
		return {
			key: stableHash({
				slot,
				backend: plan.launch.backend,
				executable: plan.executable,
				args: plan.args,
				initializationOptions: plan.initializationOptions ?? null,
				env,
				server: server.hash,
				toolchain: toolchain?.fingerprint ?? null,
				node: node?.fingerprint ?? null,
			}),
			slot,
			server,
			launch: plan.launch,
			executable: plan.executable,
			args: plan.args,
			projectRoot,
			workspaceRoot: file.workspaceRoot,
			environment,
			toolchain,
			env,
			settings: mergeSettings(toolchain?.settings ?? {}, server.settings),
			initializationOptions: plan.initializationOptions,
		};
	}
}
