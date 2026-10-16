import { statSync } from "node:fs";

import {
	type DiagnosticBatch,
	diagnoseFiles,
	type FileChange,
	type FileChangeJournal,
	formatBatchDiagnostic,
	type JournalMark,
	type LspRuntime,
	type Severity,
} from "../../core/index.js";

import { type PatchOperation, parsePatch, patchApplied, patchFileChanges } from "./apply-patch.js";
import { type BaselineStore, type BatchDiagnostic, baselineOf, contentHash, diffDiagnostics } from "./baseline.js";

export interface PreEditEvent {
	readonly sessionId: string;
	readonly toolUseId: string;
	readonly cwd: string;
	readonly toolName: string;
	readonly toolInput: unknown;
}

export interface PostEditEvent extends PreEditEvent {
	readonly toolResponse: unknown;
}

export type HookOutput =
	| Record<string, never>
	| { readonly hookSpecificOutput: { readonly hookEventName: "PostToolUse"; readonly additionalContext: string } };

export type FileStatus = "compared" | "created" | "first-check" | "environment-changed" | "unconfirmed";

export interface FileReport {
	readonly path: string;
	readonly status: FileStatus;
	/** Problems not in the baseline (all problems for a created file). */
	readonly added: readonly BatchDiagnostic[];
	readonly resolved: readonly BatchDiagnostic[];
	/** Problems that cannot be attributed to this edit: no baseline, a new provider, or a changed environment. */
	readonly existing: readonly BatchDiagnostic[];
}

export interface PostEditResult {
	readonly hookOutput: HookOutput;
	readonly changes: readonly FileChange[];
	readonly reports: readonly FileReport[];
	readonly batch: DiagnosticBatch | null;
	readonly notes: readonly string[];
}

export const APPLY_PATCH_TOOL = "apply_patch";
export const SHELL_TOOL = "Bash";

const MAX_REPORTED_DIAGNOSTICS = 20;
const MAX_PENDING_MARKS = 256;

function patchOperations(toolInput: unknown, cwd: string): PatchOperation[] {
	if (typeof toolInput === "string") return parsePatch(toolInput, cwd);
	if (typeof toolInput !== "object" || toolInput === null) return [];
	const command = (toolInput as Record<string, unknown>)["command"];
	return typeof command === "string" ? parsePatch(command, cwd) : [];
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function emptyResult(notes: readonly string[] = [], changes: readonly FileChange[] = []): PostEditResult {
	return {
		hookOutput:
			notes.length === 0
				? {}
				: {
						hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes.join("\n") },
					},
		changes,
		reports: [],
		batch: null,
		notes,
	};
}

/**
 * Turns Codex edit events into diagnostics feedback: what changed (apply_patch headers, or the file-change
 * journal for shell commands), which files to check, and what is new relative to the session's baseline.
 */
export class EditFeedback {
	private readonly marks = new Map<string, { readonly journal: FileChangeJournal; readonly mark: JournalMark }>();

	constructor(
		private readonly runtime: LspRuntime,
		private readonly baselines: BaselineStore,
	) {}

	/** PreToolUse: starts the workspace journal, marks shell commands, and baselines files a patch will touch. */
	async before(event: PreEditEvent, signal: AbortSignal): Promise<{ tracked: boolean; baselined: number }> {
		const journal = this.runtime.journal(event.cwd);
		if (event.toolName === SHELL_TOOL) {
			this.marks.set(event.toolUseId, { journal, mark: journal.mark() });
			for (const oldest of this.marks.keys()) {
				if (this.marks.size <= MAX_PENDING_MARKS) break;
				this.marks.delete(oldest);
			}
			return { tracked: true, baselined: 0 };
		}
		if (event.toolName !== APPLY_PATCH_TOOL) return { tracked: false, baselined: 0 };
		const stale = patchOperations(event.toolInput, event.cwd)
			.flatMap((operation) => (operation.kind === "move" ? [operation.from] : [operation.path]))
			.filter((path) => isFile(path))
			.filter((path) => this.baselines.get(event.sessionId, path)?.contentHash !== contentHash(path));
		if (stale.length === 0) return { tracked: true, baselined: 0 };
		const batch = await this.check(event, stale, "file(s) before the edit", signal);
		this.baselines.record(event.sessionId, batch);
		return { tracked: true, baselined: stale.length };
	}

	/** PostToolUse: syncs servers with the change, checks edited and open files, and reports the difference. */
	async after(event: PostEditEvent, signal: AbortSignal): Promise<PostEditResult> {
		const found = await this.changesOf(event);
		if (found === undefined) return emptyResult();
		const { changes, notes } = found;
		if (changes.length === 0) return emptyResult(notes);
		await this.runtime.notifyFileChanges(changes);

		const moves = event.toolName === APPLY_PATCH_TOOL ? patchOperations(event.toolInput, event.cwd) : [];
		for (const operation of moves) {
			if (operation.kind === "move") this.baselines.move(event.sessionId, operation.from, operation.path);
		}
		const deleted = new Set(changes.filter((change) => change.kind === "deleted").map((change) => change.path));
		for (const path of deleted) this.baselines.delete(event.sessionId, path);
		const created = new Set(
			changes
				.filter(
					(change) => change.kind === "created" && this.baselines.get(event.sessionId, change.path) === undefined,
				)
				.map((change) => change.path),
		);
		const edited = [
			...new Set(changes.filter((change) => change.kind !== "deleted").map((change) => change.path)),
		].filter(isFile);
		const related = this.runtime
			.openDocumentPaths(event.cwd)
			.filter((path) => !edited.includes(path) && !deleted.has(path) && isFile(path));
		if (edited.length === 0 && related.length === 0) return emptyResult(notes, changes);

		const batch = await this.check(event, [...edited, ...related], "edited file(s)", signal);
		const reports = edited.flatMap((path) => this.compare(event.sessionId, batch, path, created.has(path), true));
		reports.push(...related.flatMap((path) => this.compare(event.sessionId, batch, path, false, false)));
		const text = this.feedback(event, batch, reports, edited.length, related.length, notes);
		return {
			hookOutput:
				text === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } },
			changes,
			reports,
			batch,
			notes,
		};
	}

	private async changesOf(
		event: PostEditEvent,
	): Promise<{ changes: readonly FileChange[]; notes: readonly string[] } | undefined> {
		if (event.toolName === APPLY_PATCH_TOOL) {
			if (!patchApplied(event.toolResponse)) return undefined;
			return { changes: patchFileChanges(patchOperations(event.toolInput, event.cwd)), notes: [] };
		}
		if (event.toolName !== SHELL_TOOL) return undefined;
		const pending = this.marks.get(event.toolUseId);
		this.marks.delete(event.toolUseId);
		if (pending === undefined) {
			return { changes: [], notes: ["No PreToolUse record for this command; its file changes were not tracked."] };
		}
		const window = await pending.journal.collect(pending.mark);
		return {
			changes: window.changes,
			notes: window.incompleteReasons.map((reason) => `File changes may be incomplete: ${reason}`),
		};
	}

	private check(
		event: PreEditEvent,
		paths: readonly string[],
		label: string,
		signal: AbortSignal,
	): Promise<DiagnosticBatch> {
		const config = this.runtime.resolver.config(event.cwd);
		const severity: Severity = config.diagnostics.minimumSeverity ?? "warning";
		return diagnoseFiles(
			this.runtime,
			{
				paths,
				workspaceRoot: event.cwd,
				environmentId: this.runtime.environmentId({}, { signal }) ?? null,
				target: `${paths.length} ${label}`,
				severity,
			},
			signal,
		);
	}

	/** Compares one file with its baseline and makes the current result the new baseline. */
	private compare(
		session: string,
		batch: DiagnosticBatch,
		path: string,
		created: boolean,
		edited: boolean,
	): FileReport[] {
		const now = baselineOf(batch, path);
		if (now.providers.length === 0) return [];
		if (batch.files.some((file) => file.path === path && file.freshness === "unconfirmed")) {
			return [{ path, status: "unconfirmed", added: [], resolved: [], existing: now.diagnostics }];
		}
		const before = this.baselines.get(session, path);
		this.baselines.set(session, path, now);
		if (created) return [{ path, status: "created", added: now.diagnostics, resolved: [], existing: [] }];
		if (before === undefined || before.environmentKey !== now.environmentKey) {
			if (!edited) return [];
			const status = before === undefined ? "first-check" : "environment-changed";
			return [{ path, status, added: [], resolved: [], existing: now.diagnostics }];
		}
		const shared = (diagnostic: BatchDiagnostic, providers: readonly string[]) =>
			providers.includes(diagnostic.providerId);
		const { added, resolved } = diffDiagnostics(
			before.diagnostics.filter((diagnostic) => shared(diagnostic, now.providers)),
			now.diagnostics.filter((diagnostic) => shared(diagnostic, before.providers)),
		);
		const existing = now.diagnostics.filter((diagnostic) => !shared(diagnostic, before.providers));
		return [{ path, status: "compared", added, resolved, existing: edited ? existing : [] }];
	}

	private feedback(
		event: PostEditEvent,
		batch: DiagnosticBatch,
		reports: readonly FileReport[],
		edited: number,
		related: number,
		notes: readonly string[],
	): string | undefined {
		const body: string[] = [];
		let budget = MAX_REPORTED_DIAGNOSTICS;
		let hidden = 0;
		const list = (diagnostics: readonly BatchDiagnostic[]): void => {
			for (const diagnostic of diagnostics) {
				if (budget === 0) {
					hidden += 1;
					continue;
				}
				budget -= 1;
				body.push(`  ${formatBatchDiagnostic(diagnostic)}`);
			}
		};
		for (const report of reports) {
			if (report.added.length > 0) {
				body.push(
					report.status === "created"
						? `${report.path}: new file with ${report.added.length} problem(s)`
						: `${report.path}: ${report.added.length} new problem(s)`,
				);
				list(report.added);
			}
			if (report.existing.length > 0) {
				body.push(
					report.status === "unconfirmed"
						? `${report.path}: diagnostics not confirmed; ${report.existing.length} observed problem(s), not attributed to this edit`
						: report.status === "environment-changed"
							? `${report.path}: the environment changed since the last check; ${report.existing.length} current problem(s), not attributed to this edit`
							: `${report.path}: first check in this session; ${report.existing.length} existing problem(s), not attributed to this edit`,
				);
				list(report.existing);
			}
			if (report.resolved.length > 0) body.push(`${report.path}: ${report.resolved.length} problem(s) resolved`);
		}
		if (hidden > 0) body.push(`  ... ${hidden} more; call lsp.diagnostics for the full list`);
		if (!batch.complete)
			body.push("Diagnostics incomplete:", ...batch.incompleteReasons.map((reason) => `  ${reason}`));
		body.push(...notes);
		if (body.length === 0) return undefined;
		const scope = related > 0 ? `${edited} edited, ${related} open file(s) rechecked` : `${edited} edited file(s)`;
		return [`LSP diagnostics after ${event.toolName} (${scope}):`, ...body].join("\n");
	}
}
