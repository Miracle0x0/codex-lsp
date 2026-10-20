import { statSync } from "node:fs";

import * as z from "zod";

import type { EffectiveConfig } from "../config/loader.js";
import { type DiagnosticBatch, formatBatch, providerFailed } from "../diagnostics/batch.js";
import { DiagnosticBatchSchema } from "../diagnostics/batch-schema.js";
import type { FileSelection } from "../diagnostics/request.js";
import { DEFAULT_MAX_DIAGNOSTICS, DIAGNOSTICS_TIMEOUT_MS } from "../lsp/constants.js";
import type { ToolCallContext } from "../runtime/context.js";
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

/** Checks one file, or every file a directory scan finds; explicit checks report down to hints by default. */
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
	return runtime.diagnose(
		{
			target: path,
			scope: isDirectory ? "directory" : "file",
			workspaceRoot,
			environmentId: runtime.environmentId(input, context),
			select: isDirectory
				? (config) => scanDirectory(path, config, input, context.signal)
				: () => ({ paths: [path] }),
			severity: input.severity,
			defaultSeverity: "hint",
			servers: input.servers,
			timeoutMs: input.timeoutMs,
			limit: input.limit,
		},
		context.signal,
	);
}

function scanDirectory(
	directory: string,
	config: EffectiveConfig,
	input: DiagnosticsInput,
	signal: AbortSignal,
): FileSelection {
	const walk = walkFiles(directory, { exclude: config.diagnostics.exclude, maxFiles: input.maxFiles, signal });
	return {
		paths: walk.files,
		excludedDirectories: walk.excludedDirectories,
		incompleteReasons: [
			...(walk.limitReached ? [`maxFiles=${input.maxFiles} reached; remaining files were not scanned`] : []),
			...walk.unreadableDirectories.map((unreadable) => `cannot read directory ${unreadable}`),
		],
	};
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
