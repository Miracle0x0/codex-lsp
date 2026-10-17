import * as z from "zod";

import { ConfigError, type EffectiveConfig } from "../config/loader.js";
import type { EnvironmentContext } from "../environment/service.js";
import { findExecutable } from "../lsp/command.js";
import type { ToolCallContext } from "../runtime/context.js";
import { findProjectRoot } from "../runtime/router.js";
import type { LspRuntime } from "../runtime/runtime.js";
import { defineLspTool } from "./definition.js";
import { formatToolFailure, ToolFailure, toToolFailure } from "./failures.js";
import { WorkspaceInputShape } from "./schemas.js";

const ToolchainSchema = z.object({
	kind: z.string(),
	status: z.enum(["resolved", "unavailable"]),
	source: z.string(),
	summary: z.string(),
	facts: z.record(z.string(), z.string().nullable()),
	notes: z.array(z.string()),
	problem: z.string().optional(),
});

const BackendSchema = z.enum(["configured", "typescript-language-server", "typescript-native"]);

const StatusOutputSchema = z.object({
	workspaceRoot: z.string().nullable(),
	configError: z.array(z.object({ file: z.string(), path: z.string(), message: z.string() })).optional(),
	environmentError: z.string().optional(),
	configFiles: z
		.object({
			user: z.object({ path: z.string(), loaded: z.boolean() }),
			project: z.object({ path: z.string(), loaded: z.boolean() }).nullable(),
		})
		.optional(),
	environment: z
		.object({
			environmentId: z.string().nullable(),
			generation: z.number().int().nullable(),
			source: z.string(),
			capturedAt: z.string().nullable(),
			notes: z.array(z.string()),
		})
		.optional(),
	servers: z.array(
		z.object({
			id: z.string(),
			source: z.string(),
			state: z.enum(["installed", "missing", "disabled", "sdk-selected"]),
			command: z.array(z.string()),
			executable: z.string().nullable(),
			note: z.string().optional(),
		}),
	),
	languages: z.array(
		z.object({
			id: z.string(),
			extensions: z.array(z.string()),
			semanticServer: z.string().nullable(),
			diagnosticServers: z.array(z.string()),
			disabledServers: z.array(z.string()),
			toolchain: z.string().nullable(),
		}),
	),
	file: z
		.object({
			path: z.string(),
			language: z.string(),
			servers: z.array(
				z.object({
					serverId: z.string(),
					projectRoot: z.string(),
					backend: BackendSchema.nullable(),
					command: z.array(z.string()).nullable(),
					reason: z.string().nullable(),
					problem: z.string().nullable(),
				}),
			),
			toolchain: ToolchainSchema.nullable(),
		})
		.optional(),
	clients: z.array(
		z.object({
			key: z.string(),
			serverId: z.string(),
			projectRoot: z.string(),
			backend: BackendSchema,
			launch: z.string(),
			state: z.enum(["initializing", "ready", "dead", "retired"]),
			environmentId: z.string().nullable(),
			environmentGeneration: z.number().int().nullable(),
			environmentSource: z.string(),
			executable: z.string(),
			toolchain: z.string().nullable(),
			serverInfo: z.string().nullable(),
			refCount: z.number().int(),
			openDocuments: z.number().int(),
		}),
	),
});

type StatusOutput = z.infer<typeof StatusOutputSchema>;

function describeServers(config: EffectiveConfig, environment: EnvironmentContext): StatusOutput["servers"] {
	const servers: StatusOutput["servers"] = [...config.servers.values()].map((server) => {
		const executable = server.command[0]
			? (findExecutable(server.command[0], environment.variables, config.workspaceRoot) ?? null)
			: null;
		const base = { id: server.id, source: server.source, command: [...server.command], executable };
		if (!server.sdkSelected) return { ...base, state: executable === null ? "missing" : "installed" };
		// The backend depends on each project's SDK; pass filePath to see the one a file gets.
		return {
			...base,
			state: "sdk-selected",
			note:
				"Chosen per project from node_modules/typescript: below 7 runs " +
				`${server.command[0]} (${executable === null ? "not found" : "found"} on PATH) with that SDK's tsserver; ` +
				"7.x runs the SDK's native LSP under node.",
		};
	});
	for (const [id, source] of config.disabledServers) {
		servers.push({ id, source, state: "disabled", command: [], executable: null });
	}
	return servers;
}

async function describeFile(
	runtime: LspRuntime,
	filePath: string,
	input: { workspaceRoot?: string | undefined; environmentId?: string | undefined },
	context: ToolCallContext,
): Promise<StatusOutput["file"]> {
	const file = runtime.file({ ...input, filePath }, context);
	const serverIds = [
		...new Set([
			...(file.language.semanticServer ? [file.language.semanticServer] : []),
			...file.language.diagnosticServers,
		]),
	];
	const servers: NonNullable<StatusOutput["file"]>["servers"] = [];
	for (const serverId of serverIds) {
		const server = file.config.servers.get(serverId);
		if (server === undefined) continue;
		const projectRoot = findProjectRoot(file.path, server.rootMarkers, file.workspaceRoot);
		try {
			const target = await runtime.resolver.server(file, serverId, context.signal);
			servers.push({
				serverId,
				projectRoot,
				backend: target.launch.backend,
				command: [target.executable, ...target.args],
				reason: target.launch.reason,
				problem: null,
			});
		} catch (error) {
			const failure = toToolFailure(error);
			if (failure.code === "cancelled") throw failure;
			servers.push({
				serverId,
				projectRoot,
				backend: null,
				command: null,
				reason: null,
				problem: formatToolFailure(failure),
			});
		}
	}
	const firstRoot = servers[0]?.projectRoot;
	const toolchain =
		file.language.toolchain && firstRoot !== undefined
			? await runtime.resolver.toolchain(file.language.toolchain, file, firstRoot, context.signal)
			: null;
	return {
		path: file.path,
		language: file.language.id,
		servers,
		toolchain:
			toolchain === null
				? null
				: {
						kind: toolchain.kind,
						status: toolchain.status,
						source: toolchain.source,
						summary: toolchain.summary,
						facts: { ...toolchain.facts },
						notes: [...toolchain.notes],
						...(toolchain.problem === undefined ? {} : { problem: toolchain.problem }),
					},
	};
}

function summarize(status: StatusOutput): string {
	const lines: string[] = [`Workspace: ${status.workspaceRoot ?? "(none)"}`];
	if (status.configError) {
		lines.push(
			"Configuration is invalid:",
			...status.configError.map((issue) => `  ${issue.file}: ${issue.path}: ${issue.message}`),
		);
	}
	if (status.configFiles) {
		const project = status.configFiles.project;
		lines.push(
			`Config: user ${status.configFiles.user.path} (${status.configFiles.user.loaded ? "loaded" : "absent"})` +
				(project ? `, project ${project.path} (${project.loaded ? "loaded" : "absent"})` : ""),
		);
	}
	if (status.environmentError) lines.push(`Environment: unusable; ${status.environmentError}`);
	if (status.environment) {
		const environment = status.environment;
		lines.push(
			`Environment: ${environment.source}${environment.environmentId ? ` ${environment.environmentId}#${environment.generation}` : ""}`,
			...environment.notes.map((note) => `  ${note}`),
		);
	}
	if (status.file) {
		lines.push(`File: ${status.file.path} (${status.file.language})`);
		for (const server of status.file.servers) {
			lines.push(`  ${server.serverId} project root: ${server.projectRoot}`);
			lines.push(
				server.problem === null
					? `    ${server.backend}: ${server.command?.join(" ")} (${server.reason})`
					: `    unavailable: ${server.problem}`,
			);
		}
		const toolchain = status.file.toolchain;
		if (toolchain) {
			lines.push(`  ${toolchain.kind} toolchain: ${toolchain.status}; ${toolchain.summary} [${toolchain.source}]`);
			lines.push(...toolchain.notes.map((note) => `  note: ${note}`));
		}
	}
	const routed = new Set(
		status.languages.flatMap((language) => [language.semanticServer, ...language.diagnosticServers]),
	);
	lines.push("Routed servers:");
	for (const server of status.servers.filter(
		(item) => routed.has(item.id) || item.state === "disabled" || item.source !== "builtin",
	)) {
		lines.push(
			`  ${server.id}: ${server.state}${server.executable ? ` (${server.executable})` : ""}; source=${server.source}`,
		);
		if (server.note !== undefined) lines.push(`    ${server.note}`);
	}
	lines.push(`Active clients: ${status.clients.length}`);
	for (const client of status.clients) {
		lines.push(
			`  ${client.serverId}: ${client.state}; root=${client.projectRoot}; env=${client.environmentId ?? client.environmentSource}` +
				`${client.environmentGeneration === null ? "" : `#${client.environmentGeneration}`}; ${client.serverInfo ?? client.executable}` +
				`; ${client.backend}: ${client.launch}` +
				`${client.toolchain ? `; ${client.toolchain}` : ""}`,
		);
	}
	return lines.join("\n");
}

function describeLanguages(config: EffectiveConfig): StatusOutput["languages"] {
	return [...config.languages.values()].map((language) => ({
		id: language.id,
		extensions: [...language.extensions],
		semanticServer: language.semanticServer,
		diagnosticServers: [...language.diagnosticServers],
		disabledServers: [...language.disabledServers],
		toolchain: language.toolchain,
	}));
}

export const statusTool = defineLspTool({
	name: "status",
	title: "LSP Status",
	description:
		"Show configuration, the bound shell environment, server executables, language routes, and active clients. " +
		"With filePath it also resolves that file's toolchain (interpreter/SDK) and the exact server command and backend " +
		"each of its servers would run, without starting a language server.",
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	inputSchema: z.object({
		...WorkspaceInputShape,
		filePath: z
			.string()
			.min(1)
			.optional()
			.describe("File whose language, project root, toolchain, and server launch to resolve."),
	}),
	outputSchema: StatusOutputSchema,
	async run(runtime, input, context) {
		const workspaceRoot = runtime.workspaceRoot(input, context) ?? null;
		const clients = runtime.manager.snapshot().map(({ pid: _pid, ...client }) => client);
		let config: EffectiveConfig;
		try {
			config = runtime.resolver.config(workspaceRoot ?? undefined);
		} catch (error) {
			if (!(error instanceof ConfigError)) throw error;
			const status: StatusOutput = {
				workspaceRoot,
				configError: error.issues.map((issue) => ({ ...issue })),
				servers: [],
				languages: [],
				clients,
			};
			return { summary: summarize(status), data: status, partial: true };
		}
		const configFiles = {
			user: { ...config.files.user },
			project: config.files.project ? { ...config.files.project } : null,
		};
		let environmentId: string | undefined;
		try {
			environmentId = runtime.environmentId(input, context);
		} catch (error) {
			if (!(error instanceof ToolFailure && error.code === "environment_error")) throw error;
			// Servers are looked up on the environment's PATH, so without one only the configuration is shown.
			const status: StatusOutput = {
				workspaceRoot,
				configFiles,
				environmentError: error.message,
				servers: [],
				languages: describeLanguages(config),
				clients,
			};
			return { summary: summarize(status), data: status, partial: true };
		}
		const environment = runtime.resolver.environment(config, environmentId);
		const status: StatusOutput = {
			workspaceRoot,
			configFiles,
			environment: {
				environmentId: environment.environmentId,
				generation: environment.generation,
				source: environment.source,
				capturedAt: environment.capturedAt,
				notes: [...environment.notes],
			},
			servers: describeServers(config, environment),
			languages: describeLanguages(config),
			...(input.filePath === undefined ? {} : { file: await describeFile(runtime, input.filePath, input, context) }),
			clients,
		};
		return { summary: summarize(status), data: status };
	},
});
