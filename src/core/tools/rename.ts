import type { PrepareRenameResult, Range, WorkspaceEdit } from "vscode-languageserver-protocol";
import * as z from "zod";

import { formatBatch } from "../diagnostics/batch.js";
import { DiagnosticBatchSchema } from "../diagnostics/batch-schema.js";
import { FILE_CHANGE_KINDS } from "../documents/store.js";
import { defineLspTool } from "./definition.js";
import { ToolFailure } from "./failures.js";
import { positionParams } from "./navigation.js";
import { PositionInputShape, RangeSchema } from "./schemas.js";

type PrepareRenameResponse = PrepareRenameResult | Range | { defaultBehavior: boolean } | null;

function supportsPrepare(capability: unknown): boolean {
	return (
		typeof capability === "object" &&
		capability !== null &&
		"prepareProvider" in capability &&
		capability.prepareProvider === true
	);
}

export const prepareRenameTool = defineLspTool({
	name: "prepare_rename",
	title: "LSP Prepare Rename",
	description: "Check whether the symbol at a position can be renamed, without changing files.",
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	inputSchema: z.object(PositionInputShape),
	outputSchema: z.object({
		server: z.string(),
		canRename: z.boolean(),
		range: RangeSchema.optional(),
		placeholder: z.string().optional(),
		defaultBehavior: z.boolean().optional(),
	}),
	async run(runtime, input, context) {
		const file = runtime.file(input, context);
		return runtime.withSemantic(
			file,
			{
				server: input.server,
				signal: context.signal,
				readOnly: true,
				capability: "renameProvider",
				method: "textDocument/rename",
			},
			async (session) => {
				const server = session.client.target.server.id;
				if (!supportsPrepare(session.client.serverCapabilities?.renameProvider)) {
					throw new ToolFailure(
						"capability_unsupported",
						`${server} does not support textDocument/prepareRename.`,
					);
				}
				const result = await session.client.request<PrepareRenameResponse>(
					"textDocument/prepareRename",
					positionParams(session, input),
					context.signal,
				);
				if (result === null)
					return { summary: "Cannot rename at this position", data: { server, canRename: false } };
				if ("defaultBehavior" in result) {
					return {
						summary: result.defaultBehavior
							? "Rename supported (server default behavior)"
							: "Cannot rename at this position",
						data: { server, canRename: result.defaultBehavior, defaultBehavior: result.defaultBehavior },
					};
				}
				const range = session.positions.toPublicRange(file.path, "range" in result ? result.range : result);
				const placeholder = "placeholder" in result ? result.placeholder : undefined;
				const span = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
				return {
					summary: `Rename available at ${span}${placeholder ? ` (current: "${placeholder}")` : ""}`,
					data: { server, canRename: true, range, ...(placeholder === undefined ? {} : { placeholder }) },
				};
			},
		);
	},
});

export const RenameOutputSchema = z.object({
	server: z.string(),
	operationId: z.string().describe("Identifies this write; later hooks reuse its report instead of re-checking."),
	applied: z.boolean(),
	editCount: z.number().int(),
	changes: z.array(z.object({ path: z.string(), kind: z.enum(FILE_CHANGE_KINDS) })),
	completed: z.array(z.string()),
	failed: z.object({ operation: z.string(), error: z.string() }).optional(),
	skipped: z.array(z.string()),
	diagnostics: DiagnosticBatchSchema.nullable().describe(
		"Diagnostics for the changed files after every server was synced.",
	),
});

export const renameTool = defineLspTool({
	name: "rename",
	title: "LSP Rename",
	description:
		"Rename the symbol at a position with the language's semantic server, write the edit to disk, sync every " +
		"language server, and report diagnostics for the changed files. Run it sequentially.",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	inputSchema: z.object({
		...PositionInputShape,
		newName: z.string().min(1).describe("New symbol name."),
	}),
	outputSchema: RenameOutputSchema,
	async run(runtime, input, context) {
		const file = runtime.file(input, context);
		const { server, report } = await runtime.withSemantic(
			file,
			{
				server: input.server,
				signal: context.signal,
				readOnly: false,
				capability: "renameProvider",
				method: "textDocument/rename",
			},
			async (session) => {
				const edit = await session.client.request<WorkspaceEdit | null>(
					"textDocument/rename",
					{ ...positionParams(session, input), newName: input.newName },
					context.signal,
				);
				if (edit === null) {
					throw new ToolFailure(
						"invalid_input",
						"The server returned no edit; the symbol at this position cannot be renamed.",
					);
				}
				return { server: session.client.target.server.id, report: await runtime.edits.apply(edit, session.client) };
			},
		);

		const changedPaths = report.changes.filter((change) => change.kind !== "deleted").map((change) => change.path);
		const diagnostics =
			changedPaths.length === 0
				? null
				: await runtime.diagnose(
						{
							target: `${changedPaths.length} renamed file(s)`,
							scope: "files",
							workspaceRoot: file.workspaceRoot,
							environmentId: file.environment.environmentId ?? undefined,
							select: () => ({ paths: changedPaths }),
							severity: "warning",
							defaultSeverity: "warning",
							closeOpened: false,
						},
						context.signal,
					);

		const lines = report.applied
			? [
					`Applied ${report.editCount} edit(s) to ${report.changes.length} file change(s):`,
					...report.completed.map((item) => `  - ${item}`),
				]
			: [
					"Rename stopped before finishing:",
					...report.completed.map((item) => `  done: ${item}`),
					...(report.failed ? [`  failed: ${report.failed.operation}: ${report.failed.error}`] : []),
					...report.skipped.map((item) => `  skipped: ${item}`),
				];
		if (diagnostics) lines.push("", formatBatch(diagnostics));
		return {
			summary: lines.join("\n"),
			partial: !report.applied,
			data: {
				server,
				operationId: report.operationId,
				applied: report.applied,
				editCount: report.editCount,
				changes: report.changes.map((change) => ({ ...change })),
				completed: [...report.completed],
				...(report.failed ? { failed: report.failed } : {}),
				skipped: [...report.skipped],
				diagnostics,
			},
		};
	},
});
