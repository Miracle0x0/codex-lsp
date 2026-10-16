import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { type ConfigService, type EffectiveConfig, type EffectiveLanguage, stableHash } from "../config/loader.js";
import type { ToolchainKind } from "../config/schema.js";
import type { EnvironmentContext, EnvironmentService } from "../environment/service.js";
import { TOOLCHAIN_ADAPTERS, type ToolchainResolution } from "../environment/toolchains/index.js";
import { ancestors } from "../environment/toolchains/types.js";
import type { ServerTarget } from "../lsp/client.js";
import { findExecutable } from "../lsp/command.js";
import { TOOLCHAIN_CACHE_TTL_MS } from "../lsp/constants.js";
import { getLanguageId } from "../lsp/language-mappings.js";
import { ToolFailure } from "../tools/failures.js";

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

interface CachedToolchain {
	readonly at: number;
	readonly promise: Promise<ToolchainResolution>;
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
		if (target === undefined) {
			const extension = extname(path);
			throw new ToolFailure(
				"server_not_configured",
				`No language is configured for '${extension || path}'. Add it under "languages" in ${config.files.project?.path ?? config.files.user.path}.`,
			);
		}
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
		if (cached !== undefined && this.now() - cached.at < TOOLCHAIN_CACHE_TTL_MS) return cached.promise;
		const promise = TOOLCHAIN_ADAPTERS[kind]({
			environment: file.environment,
			projectRoot,
			workspaceRoot: file.workspaceRoot,
			config: file.config.environment,
			...(signal ? { signal } : {}),
		});
		this.toolchains.set(key, { at: this.now(), promise });
		promise.catch(() => this.toolchains.delete(key));
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
			? await this.toolchain(file.language.toolchain, file, projectRoot, signal)
			: null;
		if (toolchain?.status === "unavailable") {
			throw new ToolFailure(
				"environment_error",
				`${toolchain.kind} toolchain for ${projectRoot} is unavailable [${toolchain.source}]: ${toolchain.problem}`,
			);
		}
		const [command, ...args] = server.command;
		const executable =
			command === undefined ? undefined : findExecutable(command, environment.variables, file.workspaceRoot);
		if (executable === undefined) {
			const hint = server.installHint ? `\nInstall: ${server.installHint}` : "";
			throw new ToolFailure(
				"server_not_installed",
				`LSP server '${serverId}' is not installed in this environment: '${command}' was not found (${environment.source} PATH).${hint}`,
			);
		}
		const env = { ...environment.variables, ...server.env };
		const slot = [environment.environmentId ?? environment.source, projectRoot, serverId].join("|");
		return {
			key: stableHash({
				slot,
				executable,
				args,
				env,
				server: server.hash,
				toolchain: toolchain?.fingerprint ?? null,
			}),
			slot,
			server,
			executable,
			args,
			projectRoot,
			workspaceRoot: file.workspaceRoot,
			environment,
			toolchain,
			env,
			settings: mergeSettings(toolchain?.settings ?? {}, server.settings),
			initializationOptions: server.initializationOptions,
		};
	}
}
