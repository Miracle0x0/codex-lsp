import * as z from "zod";

import { RangeSchema, SeveritySchema } from "../tools/schemas.js";

const ProviderStatusSchema = z.enum([
	"ok",
	"timeout",
	"failed",
	"not_installed",
	"unavailable",
	"not_configured",
	"cancelled",
]);

/** Wire shape of one diagnostics run; the TypeScript type is derived from it. */
export const DiagnosticBatchSchema = z.object({
	target: z.string(),
	scope: z.enum(["file", "directory", "files"]),
	workspaceRoot: z.string().nullable(),
	environment: z.object({
		environmentId: z.string().nullable(),
		generation: z.number().int().nullable(),
		source: z.string(),
	}),
	complete: z.boolean().describe("False when a provider failed or a result could not be confirmed."),
	incompleteReasons: z.array(z.string()),
	providers: z.array(
		z.object({
			serverId: z.string(),
			language: z.string(),
			status: ProviderStatusSchema,
			mode: z.enum(["pull", "push"]).nullable(),
			filesChecked: z.number().int(),
			message: z.string().optional(),
		}),
	),
	files: z.array(
		z.object({
			path: z.string(),
			serverId: z.string(),
			documentVersion: z.number().int(),
			freshness: z.enum(["confirmed", "observed", "unconfirmed"]),
		}),
	),
	coverage: z.object({
		scannedFiles: z.number().int(),
		checkedFiles: z.number().int(),
		unsupportedFiles: z.number().int(),
		unsupportedExtensions: z.array(z.string()),
		excludedDirectories: z.number().int(),
	}),
	minimumSeverity: SeveritySchema,
	counts: z.object({
		total: z.number().int(),
		error: z.number().int(),
		warning: z.number().int(),
		information: z.number().int(),
		hint: z.number().int(),
	}),
	diagnostics: z.array(
		z.object({
			path: z.string(),
			providerId: z.string().describe("Configured server id that reported the diagnostic."),
			source: z.string().optional().describe("The server's own source label, when it sent one."),
			severity: SeveritySchema,
			code: z.union([z.string(), z.number()]).optional(),
			message: z.string(),
			range: RangeSchema,
		}),
	),
	shown: z.number().int(),
	truncated: z.boolean(),
});

export type DiagnosticBatch = z.infer<typeof DiagnosticBatchSchema>;
export type BatchDiagnostic = DiagnosticBatch["diagnostics"][number];
export type BatchProvider = DiagnosticBatch["providers"][number];
export type BatchFile = DiagnosticBatch["files"][number];
export type Severity = z.infer<typeof SeveritySchema>;
