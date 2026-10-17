import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { BUILTIN_LANGUAGES, BUILTIN_SERVERS, SDK_SELECTED_SERVERS } from "./builtins.js";
import {
	type ConfigFile,
	ConfigFileSchema,
	type DiagnosticsConfig,
	type LanguageConfig,
	type ServerConfig,
	type ToolchainKind,
} from "./schema.js";

export type ConfigSource = "builtin" | "user" | "project";

export const PROJECT_CONFIG_ENV = "LSP_TOOLS_MCP_PROJECT_CONFIG";
export const USER_CONFIG_ENV = "LSP_TOOLS_MCP_USER_CONFIG";
const DEFAULT_CONFIG_PATH = join(".codex", "lsp-client.json");

export interface ConfigIssue {
	readonly file: string;
	readonly path: string;
	readonly message: string;
}

export class ConfigError extends Error {
	override readonly name = "ConfigError";

	constructor(readonly issues: readonly ConfigIssue[]) {
		super(
			[
				"Invalid LSP configuration:",
				...issues.map((issue) => `  ${issue.file}: ${issue.path || "(root)"}: ${issue.message}`),
			].join("\n"),
		);
	}
}

export interface EffectiveServer {
	readonly id: string;
	readonly source: ConfigSource;
	readonly command: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly settings: Readonly<Record<string, unknown>>;
	readonly initializationOptions: Readonly<Record<string, unknown>> | undefined;
	readonly rootMarkers: readonly string[];
	readonly installHint: string | undefined;
	/** The built-in definition whose backend is chosen from the project's SDK; never set for configured servers. */
	readonly sdkSelected: boolean;
	/** Stable hash of the effective definition; part of the client identity. */
	readonly hash: string;
}

export interface EffectiveLanguage {
	readonly id: string;
	readonly source: ConfigSource;
	readonly extensions: readonly string[];
	readonly languageId: string | undefined;
	readonly toolchain: ToolchainKind | null;
	readonly semanticServer: string | null;
	readonly diagnosticServers: readonly string[];
	/** Servers this route names that a config layer disabled. */
	readonly disabledServers: readonly string[];
}

export interface ConfigFileInfo {
	readonly path: string;
	readonly loaded: boolean;
}

export interface EffectiveEnvironmentConfig {
	readonly source: "active-shell" | "process";
	readonly pythonInterpreter: { readonly path: string; readonly source: ConfigSource } | undefined;
	readonly extraVariables: readonly string[];
}

export interface EffectiveConfig {
	readonly workspaceRoot: string | undefined;
	readonly files: { readonly user: ConfigFileInfo; readonly project: ConfigFileInfo | undefined };
	readonly environment: EffectiveEnvironmentConfig;
	readonly diagnostics: {
		readonly exclude: readonly string[];
		readonly minimumSeverity: DiagnosticsConfig["minimumSeverity"];
	};
	readonly servers: ReadonlyMap<string, EffectiveServer>;
	readonly disabledServers: ReadonlyMap<string, ConfigSource>;
	readonly languages: ReadonlyMap<string, EffectiveLanguage>;
	languageForExtension(extension: string): EffectiveLanguage | undefined;
}

interface Layer {
	readonly source: Exclude<ConfigSource, "builtin">;
	readonly file: string;
	readonly baseDir: string;
	readonly config: ConfigFile;
}

export function stableHash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Where configuration files are looked up. The process that composes a runtime decides this once;
 * nothing below it reads the global environment or home directory for configuration.
 */
export interface ConfigSources {
	/** Variables that may override the file locations (`LSP_TOOLS_MCP_USER_CONFIG`, `LSP_TOOLS_MCP_PROJECT_CONFIG`). */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Holds the default user file and resolves relative user paths. */
	readonly homeDir: string;
}

export function configSourcesOf(env: Readonly<Record<string, string | undefined>>): ConfigSources {
	return { env, homeDir: homedir() };
}

export interface ConfigPaths {
	readonly user: string;
	readonly project: string | undefined;
}

export function configPaths(workspaceRoot: string | undefined, sources: ConfigSources): ConfigPaths {
	const projectOverride = sources.env[PROJECT_CONFIG_ENV];
	const userOverride = sources.env[USER_CONFIG_ENV];
	const user = userOverride
		? isAbsolute(userOverride)
			? userOverride
			: join(sources.homeDir, userOverride)
		: join(sources.homeDir, DEFAULT_CONFIG_PATH);
	if (projectOverride && isAbsolute(projectOverride)) return { user, project: projectOverride };
	if (workspaceRoot === undefined) return { user, project: undefined };
	return { user, project: join(workspaceRoot, projectOverride || DEFAULT_CONFIG_PATH) };
}

function readLayer(
	source: Layer["source"],
	file: string | undefined,
	baseDir: string,
	issues: ConfigIssue[],
): Layer | undefined {
	if (file === undefined) return undefined;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		issues.push({
			file,
			path: "",
			message: `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
		});
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		issues.push({
			file,
			path: "",
			message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		});
		return undefined;
	}
	const result = ConfigFileSchema.safeParse(parsed);
	if (!result.success) {
		for (const issue of result.error.issues) {
			issues.push({ file, path: issue.path.map(String).join("."), message: issue.message });
		}
		return undefined;
	}
	return { source, file, baseDir, config: result.data };
}

function toEffectiveServer(id: string, source: ConfigSource, config: ServerConfig): EffectiveServer {
	const sdkSelected = source === "builtin" && SDK_SELECTED_SERVERS.has(id);
	return {
		id,
		source,
		command: config.command,
		env: config.env ?? {},
		settings: config.settings ?? {},
		initializationOptions: config.initializationOptions,
		rootMarkers: config.rootMarkers ?? [],
		installHint: config.installHint,
		sdkSelected,
		hash: stableHash({ id, sdkSelected, ...config }),
	};
}

interface LanguageDraft {
	source: ConfigSource;
	file: string;
	config: LanguageConfig;
}

export function loadEffectiveConfig(workspaceRoot: string | undefined, sources: ConfigSources): EffectiveConfig {
	return loadConfigFiles(workspaceRoot, configPaths(workspaceRoot, sources), sources.homeDir);
}

function loadConfigFiles(workspaceRoot: string | undefined, paths: ConfigPaths, homeDir: string): EffectiveConfig {
	const issues: ConfigIssue[] = [];
	const userLayer = readLayer("user", paths.user, homeDir, issues);
	const projectLayer = readLayer("project", paths.project, workspaceRoot ?? homeDir, issues);
	if (issues.length > 0) throw new ConfigError(issues);
	const layers = [userLayer, projectLayer].filter((layer): layer is Layer => layer !== undefined);

	const servers = new Map<string, EffectiveServer>();
	for (const [id, config] of Object.entries(BUILTIN_SERVERS))
		servers.set(id, toEffectiveServer(id, "builtin", config));
	const disabledServers = new Map<string, ConfigSource>();
	const languages = new Map<string, LanguageDraft>();
	for (const [id, config] of Object.entries(BUILTIN_LANGUAGES)) {
		languages.set(id, { source: "builtin", file: "(builtin)", config });
	}

	let environmentSource: EffectiveEnvironmentConfig["source"] = "active-shell";
	let pythonInterpreter: EffectiveEnvironmentConfig["pythonInterpreter"];
	let extraVariables: readonly string[] = [];
	let exclude: readonly string[] = [];
	let minimumSeverity: DiagnosticsConfig["minimumSeverity"];

	for (const layer of layers) {
		const { config, source } = layer;
		for (const [id, entry] of Object.entries(config.servers ?? {})) {
			if ("disabled" in entry) {
				servers.delete(id);
				disabledServers.set(id, source);
			} else {
				servers.set(id, toEffectiveServer(id, source, entry));
				disabledServers.delete(id);
			}
		}
		for (const [id, entry] of Object.entries(config.languages ?? {})) {
			if (entry.disabled) {
				languages.delete(id);
				continue;
			}
			const previous = languages.get(id)?.config ?? {};
			languages.set(id, { source, file: layer.file, config: { ...previous, ...entry } });
		}
		if (config.environment?.source !== undefined) environmentSource = config.environment.source;
		if (config.environment?.python?.interpreter !== undefined) {
			const interpreter = config.environment.python.interpreter;
			pythonInterpreter = {
				path: isAbsolute(interpreter) ? interpreter : resolve(layer.baseDir, interpreter),
				source,
			};
		}
		if (config.environment?.extraVariables !== undefined) extraVariables = config.environment.extraVariables;
		if (config.diagnostics?.exclude !== undefined) exclude = config.diagnostics.exclude;
		if (config.diagnostics?.minimumSeverity !== undefined) minimumSeverity = config.diagnostics.minimumSeverity;
	}

	const effectiveLanguages = new Map<string, EffectiveLanguage>();
	const extensionOwners = new Map<string, string>();
	for (const [id, draft] of languages) {
		const { config } = draft;
		const at = (field: string): string => `languages.${id}.${field}`;
		if (config.extensions === undefined) {
			issues.push({ file: draft.file, path: at("extensions"), message: "a new language needs extensions" });
			continue;
		}
		const disabled: string[] = [];
		const checkServer = (serverId: string, path: string): boolean => {
			if (servers.has(serverId)) return true;
			if (disabledServers.has(serverId)) {
				disabled.push(serverId);
				return false;
			}
			issues.push({ file: draft.file, path, message: `unknown server '${serverId}'` });
			return false;
		};
		const semantic = config.semanticServer ?? null;
		const semanticServer = semantic !== null && checkServer(semantic, at("semanticServer")) ? semantic : null;
		const diagnosticServers = (config.diagnosticServers ?? []).filter((serverId, index) =>
			checkServer(serverId, `${at("diagnosticServers")}.${index}`),
		);
		for (const extension of config.extensions) {
			const owner = extensionOwners.get(extension);
			if (owner !== undefined && owner !== id) {
				issues.push({
					file: draft.file,
					path: at("extensions"),
					message: `extension '${extension}' is already routed to language '${owner}'`,
				});
			}
			extensionOwners.set(extension, id);
		}
		effectiveLanguages.set(id, {
			id,
			source: draft.source,
			extensions: config.extensions,
			languageId: config.languageId,
			toolchain: config.toolchain ?? null,
			semanticServer,
			diagnosticServers,
			disabledServers: [...new Set(disabled)],
		});
	}
	if (issues.length > 0) throw new ConfigError(issues);

	return {
		workspaceRoot,
		files: {
			user: { path: paths.user, loaded: userLayer !== undefined },
			project: paths.project === undefined ? undefined : { path: paths.project, loaded: projectLayer !== undefined },
		},
		environment: { source: environmentSource, pythonInterpreter, extraVariables },
		diagnostics: { exclude, minimumSeverity },
		servers,
		disabledServers,
		languages: effectiveLanguages,
		languageForExtension(extension) {
			const owner = extensionOwners.get(extension.toLowerCase()) ?? extensionOwners.get(extension);
			return owner === undefined ? undefined : effectiveLanguages.get(owner);
		},
	};
}

interface CachedConfig {
	readonly stamp: string;
	readonly config: EffectiveConfig;
}

function fileStamp(path: string | undefined): string {
	if (path === undefined) return "-";
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

/** Loads configuration per workspace root and reloads when a config file changes. */
export class ConfigService {
	private readonly cache = new Map<string, CachedConfig>();

	constructor(private readonly sources: ConfigSources) {}

	load(workspaceRoot: string | undefined): EffectiveConfig {
		const paths = configPaths(workspaceRoot, this.sources);
		const stamp = [paths.user, fileStamp(paths.user), paths.project ?? "-", fileStamp(paths.project)].join("|");
		const key = workspaceRoot ?? "";
		const cached = this.cache.get(key);
		if (cached?.stamp === stamp) return cached.config;
		const config = loadConfigFiles(workspaceRoot, paths, this.sources.homeDir);
		this.cache.set(key, { stamp, config });
		return config;
	}
}
