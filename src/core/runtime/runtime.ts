import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { ServerCapabilities } from "vscode-languageserver-protocol";

import { ConfigService, type ConfigSources } from "../config/loader.js";
import type { DiagnosticBatch } from "../diagnostics/batch.js";
import { type DiagnosticsRequest, runDiagnosticsRequest } from "../diagnostics/request.js";
import { DiagnosticService } from "../diagnostics/service.js";
import { PositionMapper } from "../documents/positions.js";
import { DocumentStore, type FileChange } from "../documents/store.js";
import { WorkspaceEditCoordinator } from "../edits/coordinator.js";
import { EnvironmentService } from "../environment/service.js";
import type { LspClient, ServerTarget } from "../lsp/client.js";
import { JOURNAL_MAX_WORKSPACES } from "../lsp/constants.js";
import { LspManager } from "../lsp/manager.js";
import { ToolFailure } from "../tools/failures.js";
import { FileChangeJournal } from "../workspace/journal.js";
import { resolveToolPath, resolveWorkspaceRoot, type ToolCallContext, type WorkspaceInput } from "./context.js";
import { type FileTarget, TargetResolver } from "./router.js";

export interface LspRuntimeOptions {
	/** Where configuration files are looked up; decided by the process that composes the runtime. */
	readonly config: ConfigSources;
	/** Workspace used when neither the tool input nor the host context names one. */
	readonly defaultWorkspaceRoot?: string;
	/** Directory with captured shell environment snapshots. */
	readonly stateDir?: string;
	/** Environment used when a call names none (for example the one a launcher bound at startup). */
	readonly defaultEnvironmentId?: string;
	readonly manager?: LspManager;
	readonly processEnv?: NodeJS.ProcessEnv;
}

export interface FileInput extends WorkspaceInput {
	readonly filePath: string;
	readonly environmentId?: string | undefined;
}

export interface SemanticSession {
	readonly client: LspClient;
	readonly file: FileTarget;
	readonly positions: PositionMapper;
}

/** Long-lived state shared by every MCP server instance in one process. */
export class LspRuntime {
	readonly manager: LspManager;
	readonly configs: ConfigService;
	readonly environments: EnvironmentService;
	readonly resolver: TargetResolver;
	readonly documents = new DocumentStore();
	readonly diagnostics: DiagnosticService;
	readonly edits: WorkspaceEditCoordinator;
	readonly defaultWorkspaceRoot: string | undefined;
	readonly defaultEnvironmentId: string | undefined;
	private readonly journals = new Map<string, FileChangeJournal>();

	constructor(options: LspRuntimeOptions) {
		this.configs = new ConfigService(options.config);
		this.manager = options.manager ?? new LspManager();
		this.defaultWorkspaceRoot = options.defaultWorkspaceRoot;
		this.defaultEnvironmentId = options.defaultEnvironmentId;
		this.environments = new EnvironmentService({
			...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
			...(options.processEnv === undefined ? {} : { processEnv: options.processEnv }),
		});
		this.resolver = new TargetResolver(this.configs, this.environments);
		this.diagnostics = new DiagnosticService(this.resolver, this.manager, this.documents);
		this.edits = new WorkspaceEditCoordinator(this.manager, this.documents);
	}

	workspaceRoot(input: WorkspaceInput, context: ToolCallContext): string | undefined {
		return resolveWorkspaceRoot(input, context, this.defaultWorkspaceRoot);
	}

	resolvePath(path: string, input: WorkspaceInput, context: ToolCallContext): string {
		return resolveToolPath(path, this.workspaceRoot(input, context));
	}

	environmentId(input: { readonly environmentId?: string | undefined }, context: ToolCallContext): string | undefined {
		return input.environmentId ?? context.environmentId ?? this.defaultEnvironmentId;
	}

	/** Resolves a regular source file argument. */
	file(input: FileInput, context: ToolCallContext): FileTarget {
		const workspaceRoot = this.workspaceRoot(input, context);
		return this.fileIn(
			resolveToolPath(input.filePath, workspaceRoot),
			workspaceRoot,
			this.environmentId(input, context) ?? null,
		);
	}

	/** Resolves an absolute file in an exact workspace and environment, without host defaults. */
	fileIn(path: string, workspaceRoot: string | undefined, environmentId: string | null): FileTarget {
		let isFile = false;
		try {
			isFile = statSync(path).isFile();
		} catch {
			throw new ToolFailure("invalid_path", `File does not exist: ${path}`);
		}
		if (!isFile) throw new ToolFailure("invalid_path", `Expected a file but found a directory: ${path}`);
		return this.resolver.file(path, workspaceRoot, environmentId ?? undefined);
	}

	async semanticTarget(file: FileTarget, server: string | undefined, signal: AbortSignal): Promise<ServerTarget> {
		return this.resolver.server(file, this.resolver.semanticServerId(file, server), signal);
	}

	/** Runs a semantic request against the file's semantic server with the document synced. */
	async withSemantic<T>(
		file: FileTarget,
		options: {
			readonly server?: string | undefined;
			readonly signal: AbortSignal;
			readonly readOnly: boolean;
			readonly capability: keyof ServerCapabilities;
			readonly method: string;
		},
		operation: (session: SemanticSession) => Promise<T>,
	): Promise<T> {
		const target = await this.semanticTarget(file, options.server, options.signal);
		return this.manager.withClient(
			target,
			async (client) => {
				if (!client.supports(options.capability, options.method)) {
					throw new ToolFailure(
						"capability_unsupported",
						`${target.server.id} does not support ${options.method} for ${file.language.id} files.`,
					);
				}
				await this.documents.sync(client, file.path, file.languageId);
				const positions = new PositionMapper((path) => client.documents.get(pathToFileURL(path).href)?.text);
				return operation({ client, file, positions });
			},
			{ signal: options.signal, readOnly: options.readOnly },
		);
	}

	/** Checks a file set with every configured diagnostic provider; see `DiagnosticsRequest`. */
	diagnose(request: DiagnosticsRequest, signal: AbortSignal): Promise<DiagnosticBatch> {
		return runDiagnosticsRequest(this.resolver, this.diagnostics, request, signal);
	}

	/** Tells every running client about file changes made outside the runtime. */
	async notifyFileChanges(changes: readonly FileChange[]): Promise<void> {
		await this.documents.applyFileChanges(this.manager.activeClients(), changes);
	}

	/** Paths of documents open in running clients for a workspace. */
	openDocumentPaths(workspaceRoot: string | undefined): string[] {
		const paths = new Set<string>();
		for (const client of this.manager.activeClients()) {
			if (client.target.workspaceRoot !== workspaceRoot) continue;
			for (const document of client.documents.values()) paths.add(document.path);
		}
		return [...paths];
	}

	/** The file-change journal for a workspace, started on first use; the least recently used is closed past the cap. */
	journal(workspaceRoot: string): FileChangeJournal {
		const existing = this.journals.get(workspaceRoot);
		if (existing !== undefined) {
			this.journals.delete(workspaceRoot);
			this.journals.set(workspaceRoot, existing);
			return existing;
		}
		const journal = new FileChangeJournal(workspaceRoot, {
			exclude: this.resolver.config(workspaceRoot).diagnostics.exclude,
		});
		this.journals.set(workspaceRoot, journal);
		for (const [root, stale] of this.journals) {
			if (this.journals.size <= JOURNAL_MAX_WORKSPACES) break;
			stale.close();
			this.journals.delete(root);
		}
		return journal;
	}

	async dispose(): Promise<void> {
		for (const journal of this.journals.values()) journal.close();
		this.journals.clear();
		await this.manager.stopAll();
	}
}

export function createLspRuntime(options: LspRuntimeOptions): LspRuntime {
	return new LspRuntime(options);
}
