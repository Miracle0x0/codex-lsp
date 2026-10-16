import { statSync } from "node:fs";

import * as z from "zod";

import {
	buildBatch,
	checkFiles,
	type DiagnosticBatch,
	formatBatch,
	providerFailed,
	type Severity,
} from "../diagnostics/batch.js";
import { DiagnosticBatchSchema } from "../diagnostics/batch-schema.js";
import { DEFAULT_MAX_DIAGNOSTICS, DIAGNOSTICS_TIMEOUT_MS } from "../lsp/constants.js";
import type { ToolCallContext } from "../runtime/context.js";
import type { FileTarget } from "../runtime/router.js";
import type { LspRuntime } from "../runtime/runtime.js";
import { walkFiles } from "../workspace/files.js";
import { defineLspTool } from "./definition.js";
import { ToolFailure } from "./failures.js";
import { FileInputShape, SeveritySchema } from "./schemas.js";

const DiagnosticsInputSchema = z.object({
	...FileInputShape,
	filePath: FileInputShape.filePath.describe("File or directory to check."),
	severity: SeveritySchema.optional().describe(
		"Minimum severity to report. Defaults to the config value or hint (all).",
	),
	servers: z
		.array(z.string().min(1))
		.min(1)
		.optional()
		.describe("Diagnostic servers to use instead of the configured ones."),
	timeoutMs: z.number().int().min(100).max(300_000).default(DIAGNOSTICS_TIMEOUT_MS),
	maxFiles: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Stop a directory scan after this many files; unchecked files are reported."),
	limit: z.number().int().min(1).default(DEFAULT_MAX_DIAGNOSTICS).describe("Maximum diagnostics to include."),
});

export type DiagnosticsInput = z.output<typeof DiagnosticsInputSchema>;

/** Shared by the diagnostics tool and host adapters that check edited files. */
export async function runDiagnostics(
	runtime: LspRuntime,
	input: DiagnosticsInput,
	context: ToolCallContext,
): Promise<DiagnosticBatch> {
	const workspaceRoot = runtime.workspaceRoot(input, context);
	const path = runtime.resolvePath(input.filePath, input, context);
	let isDirectory: boolean;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		throw new ToolFailure("invalid_path", `Path does not exist: ${path}`);
	}
	const environmentId = runtime.environmentId(input, context);
	const config = runtime.resolver.config(workspaceRoot);
	const environment = runtime.resolver.environment(config, environmentId);
	const minimumSeverity = input.severity ?? config.diagnostics.minimumSeverity ?? "hint";
	const checkOptions = {
		servers: input.servers,
		timeoutMs: input.timeoutMs,
		signal: context.signal,
		closeOpened: isDirectory,
	};

	if (!isDirectory) {
		const file = runtime.resolver.file(path, workspaceRoot, environmentId);
		return buildBatch({
			target: path,
			scope: "file",
			workspaceRoot,
			environment,
			results: await checkFiles(runtime.diagnostics, [file], checkOptions),
			coverage: { scannedFiles: 1, unsupportedFiles: 0, unsupportedExtensions: [], excludedDirectories: 0 },
			minimumSeverity,
			limit: input.limit,
		});
	}

	const walk = walkFiles(path, {
		exclude: config.diagnostics.exclude,
		maxFiles: input.maxFiles,
		signal: context.signal,
	});
	const files: FileTarget[] = [];
	const unsupported = new Set<string>();
	for (const filePath of walk.files) {
		const file = runtime.resolver.fileTarget(filePath, workspaceRoot, config, environment);
		if (file !== undefined) files.push(file);
		else unsupported.add(extensionOf(filePath));
	}
	const extraIncompleteReasons = [
		...(walk.limitReached ? [`maxFiles=${input.maxFiles} reached; remaining files were not scanned`] : []),
		...walk.unreadableDirectories.map((directory) => `cannot read directory ${directory}`),
	];
	return buildBatch({
		target: path,
		scope: "directory",
		workspaceRoot,
		environment,
		results: await checkFiles(runtime.diagnostics, files, checkOptions),
		coverage: {
			scannedFiles: walk.files.length,
			unsupportedFiles: walk.files.length - files.length,
			unsupportedExtensions: [...unsupported].sort(),
			excludedDirectories: walk.excludedDirectories,
		},
		minimumSeverity,
		limit: input.limit,
		extraIncompleteReasons,
	});
}

export interface FileSetInput {
	/** Absolute paths; files of unconfigured languages are counted as unsupported. */
	readonly paths: readonly string[];
	readonly workspaceRoot: string | undefined;
	readonly environmentId: string | null;
	/** Label for the batch, for example "2 edited file(s)". */
	readonly target: string;
	readonly severity: Severity;
	readonly timeoutMs?: number;
}

/** Checks an explicit set of files (edited or renamed ones) in one workspace and environment. */
export async function diagnoseFiles(
	runtime: LspRuntime,
	input: FileSetInput,
	signal: AbortSignal,
): Promise<DiagnosticBatch> {
	const config = runtime.resolver.config(input.workspaceRoot);
	const environment = runtime.resolver.environment(config, input.environmentId ?? undefined);
	const files: FileTarget[] = [];
	const unsupported = new Set<string>();
	for (const path of input.paths) {
		const file = runtime.resolver.fileTarget(path, input.workspaceRoot, config, environment);
		if (file !== undefined) files.push(file);
		else unsupported.add(extensionOf(path));
	}
	return buildBatch({
		target: input.target,
		scope: "files",
		workspaceRoot: input.workspaceRoot,
		environment,
		results: await checkFiles(runtime.diagnostics, files, {
			timeoutMs: input.timeoutMs ?? DIAGNOSTICS_TIMEOUT_MS,
			signal,
			closeOpened: false,
		}),
		coverage: {
			scannedFiles: input.paths.length,
			unsupportedFiles: input.paths.length - files.length,
			unsupportedExtensions: [...unsupported].sort(),
			excludedDirectories: 0,
		},
		minimumSeverity: input.severity,
	});
}

function extensionOf(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot) : "(none)";
}

export const diagnosticsTool = defineLspTool({
	name: "diagnostics",
	title: "LSP Diagnostics",
	description:
		"Check a file or directory with every configured diagnostic server (for example Pyright and Ruff together). " +
		"Code problems are normal results; isError means a provider failed and the batch is incomplete.",
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	inputSchema: DiagnosticsInputSchema,
	outputSchema: DiagnosticBatchSchema,
	async run(runtime, input, context) {
		const batch = await runDiagnostics(runtime, input, context);
		return { summary: formatBatch(batch), data: batch, partial: providerFailed(batch) };
	},
});
