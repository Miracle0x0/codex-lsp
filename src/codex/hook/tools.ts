import { isAbsolute } from "node:path";
import * as z from "zod";
import {
	DiagnosticBatchSchema,
	defineLspTool,
	formatToolFailure,
	type RegisteredLspTool,
	toToolFailure,
} from "../../core/index.js";

import type { BaselineStore } from "./baseline.js";
import type { EditFeedback, HookOutput } from "./edit-feedback.js";

const HOOK_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Fields Codex fills from hook placeholders; see hooks/hooks.json. */
const HookEventShape = {
	sessionId: z.string().min(1),
	toolUseId: z.string().min(1),
	cwd: z.string().refine(isAbsolute, "cwd must be an absolute path"),
	toolName: z.string().min(1),
	toolInput: z.unknown(),
};

export function preEditSnapshotTool(feedback: EditFeedback): RegisteredLspTool {
	return defineLspTool({
		name: "pre_edit_snapshot",
		title: "Codex PreToolUse hook: snapshot before an edit",
		description:
			"Codex hook endpoint, called by the plugin's PreToolUse hook; not for direct use. Records diagnostics or a file-change mark before an edit.",
		annotations: HOOK_ANNOTATIONS,
		inputSchema: z.object(HookEventShape),
		outputSchema: z.object({ tracked: z.boolean(), baselined: z.number().int(), error: z.string().optional() }),
		async run(_runtime, input, context) {
			try {
				return { summary: "{}", data: await feedback.before(input, context.signal) };
			} catch (error) {
				// A failed snapshot must not block the edit; the PostToolUse check reports problems.
				return {
					summary: "{}",
					data: { tracked: false, baselined: 0, error: formatToolFailure(toToolFailure(error)) },
				};
			}
		},
	});
}

const FileReportSchema = z.object({
	path: z.string(),
	status: z.enum(["compared", "created", "first-check", "environment-changed", "unconfirmed"]),
	added: z.number().int(),
	resolved: z.number().int(),
	existing: z.number().int(),
});

export function postEditDiagnosticsTool(feedback: EditFeedback): RegisteredLspTool {
	return defineLspTool({
		name: "post_edit_diagnostics",
		title: "Codex PostToolUse hook: diagnostics after an edit",
		description:
			"Codex hook endpoint, called by the plugin's PostToolUse hook; not for direct use. Returns Codex hook output JSON as text.",
		annotations: HOOK_ANNOTATIONS,
		inputSchema: z.object({ ...HookEventShape, turnId: z.string().min(1).optional(), toolResponse: z.unknown() }),
		outputSchema: z.object({
			hookOutput: z.record(z.string(), z.unknown()),
			changes: z.array(z.object({ path: z.string(), kind: z.enum(["created", "changed", "deleted"]) })),
			files: z.array(FileReportSchema),
			diagnostics: DiagnosticBatchSchema.nullable(),
			notes: z.array(z.string()),
			error: z.string().optional(),
		}),
		async run(_runtime, input, context) {
			try {
				const result = await feedback.after(input, context.signal);
				return {
					summary: JSON.stringify(result.hookOutput),
					data: {
						hookOutput: result.hookOutput,
						changes: result.changes.map((change) => ({ ...change })),
						files: result.reports.map((report) => ({
							path: report.path,
							status: report.status,
							added: report.added.length,
							resolved: report.resolved.length,
							existing: report.existing.length,
						})),
						diagnostics: result.batch,
						notes: [...result.notes],
					},
				};
			} catch (error) {
				// Hook failures are not surfaced by Codex, so a failed check is reported to the model instead.
				const message = formatToolFailure(toToolFailure(error));
				const hookOutput: HookOutput = {
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: `LSP diagnostics after ${input.toolName} failed: ${message}`,
					},
				};
				return {
					summary: JSON.stringify(hookOutput),
					data: { hookOutput, changes: [], files: [], diagnostics: null, notes: [], error: message },
				};
			}
		},
	});
}

const RenameDiagnosticsSchema = z.object({ diagnostics: DiagnosticBatchSchema.nullable() });

/** Rename checks the files it wrote; recording that result keeps later edit diffs from re-reporting it. */
export function recordingRename(rename: RegisteredLspTool, baselines: BaselineStore): RegisteredLspTool {
	return {
		...rename,
		async run(runtime, input, context) {
			const result = await rename.run(runtime, input, context);
			const parsed = RenameDiagnosticsSchema.safeParse(result.data);
			if (context.sessionId !== undefined && parsed.success && parsed.data.diagnostics !== null) {
				baselines.record(context.sessionId, parsed.data.diagnostics);
			}
			return result;
		},
	};
}
