import type { EffectiveConfig } from "../config/loader.js";
import { DIAGNOSTICS_TIMEOUT_MS } from "../lsp/constants.js";
import { type FileTarget, type TargetResolver, unconfiguredLanguage } from "../runtime/router.js";
import { buildBatch, checkFiles, type DiagnosticBatch, type Severity } from "./batch.js";
import type { DiagnosticService } from "./service.js";

/** The files an entry point chose, with what its selection could not cover. */
export interface FileSelection {
	readonly paths: readonly string[];
	readonly excludedDirectories?: number;
	readonly incompleteReasons?: readonly string[];
}

/**
 * One diagnostics check of a file set. Entry points select the files and state their policy; the
 * request resolves configuration and environment once and builds the complete batch.
 */
export interface DiagnosticsRequest {
	/** Label for the batch: the checked path or, for example, "2 edited file(s)". */
	readonly target: string;
	/** "file" is one explicit file, whose unconfigured language is an error rather than coverage. */
	readonly scope: DiagnosticBatch["scope"];
	readonly workspaceRoot: string | undefined;
	/** The exact environment to check in; host defaults are applied by the caller. */
	readonly environmentId: string | undefined;
	/** Chooses the files once the configuration is known (a directory scan needs its excludes). */
	readonly select: (config: EffectiveConfig) => FileSelection;
	/** Overrides the configured minimum severity. */
	readonly severity?: Severity | undefined;
	/** Minimum severity when neither the request nor the configuration sets one. */
	readonly defaultSeverity: Severity;
	/** Overrides the configured diagnostic servers for every language. */
	readonly servers?: readonly string[] | undefined;
	readonly timeoutMs?: number;
	/** Maximum diagnostics to include; omit for the complete result that edit baselines compare. */
	readonly limit?: number;
}

function extensionOf(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot) : "(none)";
}

export async function runDiagnosticsRequest(
	resolver: TargetResolver,
	service: DiagnosticService,
	request: DiagnosticsRequest,
	signal: AbortSignal,
): Promise<DiagnosticBatch> {
	const config = resolver.config(request.workspaceRoot);
	const environment = resolver.environment(config, request.environmentId);
	const selection = request.select(config);
	const files: FileTarget[] = [];
	const unsupported = new Set<string>();
	for (const path of selection.paths) {
		const file = resolver.fileTarget(path, request.workspaceRoot, config, environment);
		if (file !== undefined) files.push(file);
		else if (request.scope === "file") throw unconfiguredLanguage(path, config);
		else unsupported.add(extensionOf(path));
	}
	return buildBatch({
		target: request.target,
		scope: request.scope,
		workspaceRoot: request.workspaceRoot,
		environment,
		results: await checkFiles(service, files, {
			servers: request.servers,
			timeoutMs: request.timeoutMs ?? DIAGNOSTICS_TIMEOUT_MS,
			signal,
		}),
		coverage: {
			scannedFiles: selection.paths.length,
			unsupportedFiles: selection.paths.length - files.length,
			unsupportedExtensions: [...unsupported].sort(),
			excludedDirectories: selection.excludedDirectories ?? 0,
		},
		minimumSeverity: request.severity ?? config.diagnostics.minimumSeverity ?? request.defaultSeverity,
		...(request.limit === undefined ? {} : { limit: request.limit }),
		...(selection.incompleteReasons === undefined ? {} : { extraIncompleteReasons: selection.incompleteReasons }),
	});
}
