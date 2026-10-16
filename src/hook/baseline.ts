import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { DiagnosticBatch } from "@code-yeongyu/lsp-tools-mcp";

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

/** What a batch says about one file, in baseline form. */
export function baselineOf(batch: DiagnosticBatch, path: string): FileBaseline {
	return {
		environmentKey: environmentKey(batch),
		contentHash: contentHash(path),
		providers: [...new Set(batch.files.filter((file) => file.path === path).map((file) => file.serverId))],
		diagnostics: batch.diagnostics.filter((diagnostic) => diagnostic.path === path),
	};
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

	/** Records every file a batch checked as the new baseline for the session. */
	record(session: string, batch: DiagnosticBatch): void {
		for (const path of new Set(batch.files.map((file) => file.path)))
			this.set(session, path, baselineOf(batch, path));
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
