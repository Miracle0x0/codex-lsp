import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { DiagnosticBatch } from "../../core/index.js";

export type BatchDiagnostic = DiagnosticBatch["diagnostics"][number];

/** Diagnostics last observed for one file, with what they were computed against. */
export interface FileBaseline {
	readonly environmentKey: string;
	/** Hash of the file text the diagnostics describe; null when the file could not be read. */
	readonly contentHash: string | null;
	/** Diagnostic servers that produced a result for the file; only their diagnostics are comparable. */
	readonly providers: readonly string[];
	readonly diagnostics: readonly BatchDiagnostic[];
}

const MAX_SESSIONS = 32;
const MAX_FILES_PER_SESSION = 4_096;

export function environmentKey(batch: DiagnosticBatch): string {
	const { environmentId, generation, source } = batch.environment;
	return `${source}:${environmentId ?? "-"}#${generation ?? "-"}`;
}

export function contentHash(path: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

/** Identity used to compare diagnostics across edits; positions are left out because edits shift lines. */
function fingerprint(diagnostic: BatchDiagnostic): string {
	return JSON.stringify([diagnostic.providerId, diagnostic.severity, diagnostic.code ?? null, diagnostic.message]);
}

/** Multiset difference: diagnostics in `after` beyond those in `before`, and the reverse. */
export function diffDiagnostics(
	before: readonly BatchDiagnostic[],
	after: readonly BatchDiagnostic[],
): { readonly added: BatchDiagnostic[]; readonly resolved: BatchDiagnostic[] } {
	const remaining = (from: readonly BatchDiagnostic[], minus: readonly BatchDiagnostic[]): BatchDiagnostic[] => {
		const counts = new Map<string, number>();
		for (const diagnostic of minus)
			counts.set(fingerprint(diagnostic), (counts.get(fingerprint(diagnostic)) ?? 0) + 1);
		return from.filter((diagnostic) => {
			const key = fingerprint(diagnostic);
			const count = counts.get(key) ?? 0;
			if (count === 0) return true;
			counts.set(key, count - 1);
			return false;
		});
	};
	return { added: remaining(after, before), resolved: remaining(before, after) };
}

/** What one batch says about one file, in baseline form. */
export interface FileResult extends FileBaseline {
	/** False when a provider could not confirm its result for the file's current content. */
	readonly confirmed: boolean;
}

/**
 * Every file a batch checked, in one pass over its files and diagnostics. Content hashes are read when
 * the projection is made, right after the check, so each describes the text the diagnostics came from.
 */
export function projectBatch(batch: DiagnosticBatch): ReadonlyMap<string, FileResult> {
	const key = environmentKey(batch);
	const drafts = new Map<string, { providers: Set<string>; diagnostics: BatchDiagnostic[]; confirmed: boolean }>();
	for (const file of batch.files) {
		const draft = drafts.get(file.path) ?? { providers: new Set<string>(), diagnostics: [], confirmed: true };
		draft.providers.add(file.serverId);
		if (file.freshness === "unconfirmed") draft.confirmed = false;
		drafts.set(file.path, draft);
	}
	for (const diagnostic of batch.diagnostics) drafts.get(diagnostic.path)?.diagnostics.push(diagnostic);
	const files = new Map<string, FileResult>();
	for (const [path, draft] of drafts) {
		files.set(path, {
			environmentKey: key,
			contentHash: contentHash(path),
			providers: [...draft.providers],
			diagnostics: draft.diagnostics,
			confirmed: draft.confirmed,
		});
	}
	return files;
}

/** Per-session diagnostic baselines, bounded in sessions and files (least recently used are dropped). */
export class BaselineStore {
	private readonly sessions = new Map<string, Map<string, FileBaseline>>();

	get(session: string, path: string): FileBaseline | undefined {
		return this.files(session).get(path);
	}

	set(session: string, path: string, baseline: FileBaseline): void {
		const files = this.files(session);
		files.delete(path);
		files.set(path, baseline);
		for (const oldest of files.keys()) {
			if (files.size <= MAX_FILES_PER_SESSION) break;
			files.delete(oldest);
		}
	}

	delete(session: string, path: string): void {
		this.files(session).delete(path);
	}

	move(session: string, from: string, to: string): void {
		const baseline = this.get(session, from);
		this.delete(session, from);
		if (baseline !== undefined) this.set(session, to, baseline);
	}

	/**
	 * Makes a file's result its new baseline and returns the baseline it replaced. An unconfirmed result
	 * cannot tell what changed, so it never replaces one: the old baseline stays and `accepted` is false.
	 */
	accept(
		session: string,
		path: string,
		result: FileResult,
	): { readonly accepted: boolean; readonly previous: FileBaseline | undefined } {
		const previous = this.get(session, path);
		if (!result.confirmed) return { accepted: false, previous };
		const { confirmed: _confirmed, ...baseline } = result;
		this.set(session, path, baseline);
		return { accepted: true, previous };
	}

	/** Records every file a batch checked as the new baseline for the session. */
	record(session: string, batch: DiagnosticBatch): void {
		for (const [path, result] of projectBatch(batch)) this.accept(session, path, result);
	}

	private files(session: string): Map<string, FileBaseline> {
		let files = this.sessions.get(session);
		if (files === undefined) {
			files = new Map();
		} else {
			this.sessions.delete(session);
		}
		this.sessions.set(session, files);
		for (const oldest of this.sessions.keys()) {
			if (this.sessions.size <= MAX_SESSIONS) break;
			this.sessions.delete(oldest);
		}
		return files;
	}
}
