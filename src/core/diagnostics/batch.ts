import type { Diagnostic } from "vscode-languageserver-protocol";

import { PositionMapper } from "../documents/positions.js";
import type { EnvironmentContext } from "../environment/service.js";
import type { FileTarget } from "../runtime/router.js";
import type { BatchDiagnostic, BatchFile, BatchProvider, DiagnosticBatch, Severity } from "./batch-schema.js";
import type { DiagnosticService, ProviderOutcome } from "./service.js";

export type { DiagnosticBatch, Severity } from "./batch-schema.js";

const SEVERITY_BY_CODE: Readonly<Record<number, Severity>> = { 1: "error", 2: "warning", 3: "information", 4: "hint" };
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 1, warning: 2, information: 3, hint: 4 };

export interface LanguageOutcome {
	readonly language: string;
	readonly outcomes: readonly ProviderOutcome[];
}

export interface CheckOptions {
	/** Overrides the configured diagnostic servers for every language. */
	readonly servers?: readonly string[] | undefined;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}

/** Runs every configured diagnostic provider for the files, grouped by language; providers run in parallel. */
export async function checkFiles(
	service: DiagnosticService,
	files: readonly FileTarget[],
	options: CheckOptions,
): Promise<LanguageOutcome[]> {
	const byLanguage = new Map<string, FileTarget[]>();
	for (const file of files) {
		const group = byLanguage.get(file.language.id) ?? [];
		group.push(file);
		byLanguage.set(file.language.id, group);
	}
	return Promise.all(
		[...byLanguage.entries()].map(async ([language, group]) => {
			const first = group[0];
			const servers = options.servers ?? first?.language.diagnosticServers ?? [];
			const outcomes =
				servers.length === 0
					? [
							{
								serverId: "(none)",
								status: "not_configured" as const,
								mode: null,
								message: `Language '${language}' has no diagnostic servers configured.`,
								filesChecked: 0,
								results: [],
							},
						]
					: await Promise.all(servers.map((serverId) => service.runProvider(serverId, group, options)));
			return { language, outcomes };
		}),
	);
}

/** LSP 3.18 allows markup messages; tools report plain text. */
export function messageText(diagnostic: Diagnostic): string {
	return typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
}

export function severityOf(diagnostic: Diagnostic): Severity {
	return SEVERITY_BY_CODE[diagnostic.severity ?? 1] ?? "error";
}

export function meetsSeverity(severity: Severity, minimum: Severity): boolean {
	return SEVERITY_RANK[severity] <= SEVERITY_RANK[minimum];
}

export interface BatchInput {
	readonly target: string;
	readonly scope: DiagnosticBatch["scope"];
	readonly workspaceRoot: string | undefined;
	readonly environment: EnvironmentContext;
	readonly results: readonly LanguageOutcome[];
	readonly coverage: Omit<DiagnosticBatch["coverage"], "checkedFiles">;
	readonly minimumSeverity: Severity;
	/** Omit for complete internal results used by edit baselines. */
	readonly limit?: number;
	readonly extraIncompleteReasons?: readonly string[];
}

export function buildBatch(input: BatchInput): DiagnosticBatch {
	const providers: BatchProvider[] = [];
	const files: BatchFile[] = [];
	const diagnostics: BatchDiagnostic[] = [];
	const reasons = [...(input.extraIncompleteReasons ?? [])];
	const checked = new Set<string>();

	for (const { language, outcomes } of input.results) {
		for (const outcome of outcomes) {
			providers.push({
				serverId: outcome.serverId,
				language,
				status: outcome.status,
				mode: outcome.mode,
				filesChecked: outcome.filesChecked,
				...(outcome.message === undefined ? {} : { message: outcome.message }),
			});
			if (outcome.status !== "ok")
				reasons.push(`${outcome.serverId} (${language}): ${outcome.message ?? outcome.status}`);
			for (const result of outcome.results) {
				checked.add(result.file.path);
				files.push({
					path: result.file.path,
					serverId: result.serverId,
					documentVersion: result.documentVersion,
					freshness: result.freshness,
				});
				if (result.freshness === "unconfirmed") {
					reasons.push(
						result.unconfirmedReason ??
							`${result.serverId} did not confirm diagnostics for ${result.file.path} after other files changed`,
					);
				}
				const positions = new PositionMapper((path) =>
					path === result.file.path ? result.documentText : undefined,
				);
				const seen = new Set<string>();
				for (const diagnostic of result.diagnostics) {
					const message = messageText(diagnostic);
					const key = JSON.stringify([diagnostic.range, diagnostic.code, message]);
					if (seen.has(key)) continue;
					seen.add(key);
					diagnostics.push({
						path: result.file.path,
						providerId: result.serverId,
						...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
						severity: severityOf(diagnostic),
						...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
						message,
						range: positions.toPublicRange(result.file.path, diagnostic.range),
					});
				}
			}
		}
	}

	const matching = diagnostics
		.filter((diagnostic) => meetsSeverity(diagnostic.severity, input.minimumSeverity))
		.sort(
			(a, b) =>
				SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
				a.path.localeCompare(b.path) ||
				a.range.start.line - b.range.start.line ||
				a.range.start.character - b.range.start.character,
		);
	const counts = { total: matching.length, error: 0, warning: 0, information: 0, hint: 0 };
	for (const diagnostic of matching) counts[diagnostic.severity] += 1;
	const shown = matching.slice(0, input.limit);
	return {
		target: input.target,
		scope: input.scope,
		workspaceRoot: input.workspaceRoot ?? null,
		environment: {
			environmentId: input.environment.environmentId,
			generation: input.environment.generation,
			source: input.environment.source,
		},
		complete: reasons.length === 0,
		incompleteReasons: reasons,
		providers,
		files,
		coverage: { ...input.coverage, checkedFiles: checked.size },
		minimumSeverity: input.minimumSeverity,
		counts,
		diagnostics: shown,
		shown: shown.length,
		truncated: shown.length < matching.length,
	};
}

export function providerFailed(batch: DiagnosticBatch): boolean {
	return batch.providers.some((provider) => provider.status !== "ok");
}

export function formatBatchDiagnostic(diagnostic: BatchDiagnostic): string {
	const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
	const source = diagnostic.source && diagnostic.source !== diagnostic.providerId ? `/${diagnostic.source}` : "";
	const { line, character } = diagnostic.range.start;
	return `${diagnostic.path}:${line}:${character} ${diagnostic.severity} [${diagnostic.providerId}${source}${code}] ${diagnostic.message}`;
}

export function formatBatch(batch: DiagnosticBatch): string {
	const providers = batch.providers.map((provider) => provider.serverId).join(", ") || "none";
	const { counts } = batch;
	const lines = [
		`Diagnostics for ${batch.target}: ${counts.total} (${counts.error} errors, ${counts.warning} warnings, ` +
			`${counts.information} info, ${counts.hint} hints) from ${providers}; ${batch.coverage.checkedFiles} files checked.`,
	];
	if (batch.environment.source === "unbound")
		lines.push("Environment: not bound to a shell; using the MCP process environment.");
	if (batch.truncated) lines.push(`Showing ${batch.shown} of ${counts.total}.`);
	lines.push(...batch.diagnostics.map(formatBatchDiagnostic));
	if (!batch.complete) lines.push("Incomplete:", ...batch.incompleteReasons.map((reason) => `  ${reason}`));
	return lines.join("\n");
}
