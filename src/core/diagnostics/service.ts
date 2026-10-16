import type { Diagnostic, DocumentDiagnosticReport } from "vscode-languageserver-protocol";

import type { DocumentStore } from "../documents/store.js";
import type { LspClient, OpenDocument, PublishedDiagnostics, ServerTarget } from "../lsp/client.js";
import { BACKGROUND_WORK_START_MS, DIAGNOSTICS_CONCURRENCY, DIAGNOSTICS_SETTLE_MS } from "../lsp/constants.js";
import type { LspManager } from "../lsp/manager.js";
import type { FileTarget, TargetResolver } from "../runtime/router.js";
import { ToolFailure, type ToolFailureCode, toToolFailure } from "../tools/failures.js";

/** How strongly a result is tied to the content the server last saw. */
export type Freshness = "confirmed" | "observed" | "unconfirmed";

export type ProviderStatus =
	| "ok"
	| "timeout"
	| "failed"
	| "not_installed"
	| "unavailable"
	| "not_configured"
	| "cancelled";

export interface FileDiagnostics {
	readonly file: FileTarget;
	readonly serverId: string;
	readonly freshness: Freshness;
	/** Why an unconfirmed result could not be confirmed. */
	readonly unconfirmedReason?: string;
	readonly documentVersion: number;
	readonly diagnostics: readonly Diagnostic[];
	readonly documentText: string;
}

export interface ProviderOutcome {
	readonly serverId: string;
	readonly status: ProviderStatus;
	readonly mode: "pull" | "push" | null;
	readonly message: string | undefined;
	readonly filesChecked: number;
	readonly results: readonly FileDiagnostics[];
}

export interface DiagnosticRunOptions {
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	/** Close documents this run opened, for directory scans that would otherwise pin every file. */
	readonly closeOpened: boolean;
}

const STATUS_BY_FAILURE: Partial<Record<ToolFailureCode, ProviderStatus>> = {
	server_not_installed: "not_installed",
	server_not_configured: "not_configured",
	environment_error: "unavailable",
	timeout: "timeout",
	cancelled: "cancelled",
};

const SERVER_CANCELLED = -32802;

function isServerCancelled(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === SERVER_CANCELLED;
}

interface Collected {
	readonly diagnostics: readonly Diagnostic[];
	readonly freshness: Freshness;
	readonly unconfirmedReason?: string;
}

function diagnosticKey(diagnostic: Diagnostic): string {
	return JSON.stringify([diagnostic.range, diagnostic.source ?? null, diagnostic.code ?? null, diagnostic.message]);
}

export class DiagnosticService {
	constructor(
		private readonly resolver: TargetResolver,
		private readonly manager: LspManager,
		private readonly documents: DocumentStore,
	) {}

	/** Checks the files with one provider; the files may span several project roots. */
	async runProvider(
		serverId: string,
		files: readonly FileTarget[],
		options: DiagnosticRunOptions,
	): Promise<ProviderOutcome> {
		const results: FileDiagnostics[] = [];
		let mode: ProviderOutcome["mode"] = null;
		try {
			const groups = new Map<string, { target: ServerTarget; files: FileTarget[] }>();
			for (const file of files) {
				const target = await this.resolver.server(file, serverId, options.signal);
				const group = groups.get(target.key) ?? { target, files: [] };
				group.files.push(file);
				groups.set(target.key, group);
			}
			for (const { target, files: groupFiles } of groups.values()) {
				await this.manager.withClient(
					target,
					async (client) => {
						// Bounded concurrency: push servers debounce per document, so serial checks of big directories crawl.
						const collected = new Array<FileDiagnostics>(groupFiles.length);
						let next = 0;
						const worker = async (): Promise<void> => {
							while (next < groupFiles.length) {
								options.signal.throwIfAborted();
								const index = next++;
								const file = groupFiles[index];
								if (file !== undefined) collected[index] = await this.collect(client, file, serverId, options);
							}
						};
						await Promise.all(
							Array.from({ length: Math.min(DIAGNOSTICS_CONCURRENCY, groupFiles.length) }, worker),
						);
						results.push(...collected);
						mode = client.supportsPullDiagnostics() ? "pull" : "push";
					},
					{ signal: options.signal, readOnly: true },
				);
			}
			return { serverId, status: "ok", mode, message: undefined, filesChecked: results.length, results };
		} catch (error) {
			const failure = toToolFailure(error);
			return {
				serverId,
				status: STATUS_BY_FAILURE[failure.code] ?? "failed",
				mode,
				message: `[${failure.code}] ${failure.message}`,
				filesChecked: results.length,
				results,
			};
		}
	}

	private async collect(
		client: LspClient,
		file: FileTarget,
		serverId: string,
		options: DiagnosticRunOptions,
	): Promise<FileDiagnostics> {
		const syncedBefore = client.documents.get(file.uri)?.syncSeq;
		const { document, opened } = await this.documents.sync(client, file.path, file.languageId);
		const changed = opened || document.syncSeq !== syncedBefore;
		try {
			const collected: Collected = client.supportsPullDiagnostics()
				? await this.pullSettled(client, document, changed, options)
				: await this.push(client, document, options);
			return {
				file,
				serverId,
				freshness: collected.freshness,
				...(collected.unconfirmedReason === undefined ? {} : { unconfirmedReason: collected.unconfirmedReason }),
				documentVersion: document.version,
				diagnostics: collected.diagnostics,
				documentText: document.text,
			};
		} finally {
			if (opened && options.closeOpened) await this.documents.close(client, file.uri);
		}
	}

	private async pull(
		client: LspClient,
		uri: string,
		signal: AbortSignal,
		retried = false,
	): Promise<{ diagnostics: readonly Diagnostic[]; freshness: Freshness }> {
		const previous = client.pullCache.get(uri);
		let report: DocumentDiagnosticReport;
		try {
			report = await client.request<DocumentDiagnosticReport>(
				"textDocument/diagnostic",
				{ textDocument: { uri }, ...(previous?.resultId ? { previousResultId: previous.resultId } : {}) },
				signal,
			);
		} catch (error) {
			if (!retried && isServerCancelled(error)) return this.pull(client, uri, signal, true);
			throw error;
		}
		const diagnostics = report.kind === "unchanged" ? (previous?.diagnostics ?? []) : report.items;
		client.pullCache.set(uri, { resultId: report.resultId, diagnostics });
		return { diagnostics, freshness: "confirmed" };
	}

	/**
	 * Pulls once the server finished the work the change started. Servers that report progress may answer
	 * pulls with empty results while they load (rust-analyzer does) and may push results of background
	 * checks (cargo check) that pulls do not include, so those pushes are merged in.
	 */
	private async pullSettled(
		client: LspClient,
		document: OpenDocument,
		changed: boolean,
		options: DiagnosticRunOptions,
	): Promise<Collected> {
		// Progress the server began while handling earlier messages has arrived once the barrier answers.
		await client.barrier();
		let busyReason: string | undefined;
		if (client.reportsProgress) {
			const deadline = Date.now() + options.timeoutMs;
			let settle = changed;
			while (true) {
				const idle = await client.waitUntilIdle(Math.max(0, deadline - Date.now()), options.signal);
				if (!idle) {
					busyReason = `${client.target.server.id} was still busy (${client.busyWith().join(", ")}) after ${options.timeoutMs}ms`;
					break;
				}
				if (!settle) break;
				const remaining = deadline - Date.now();
				settle = await client.waitUntilBusy(
					Math.min(BACKGROUND_WORK_START_MS, Math.max(0, remaining)),
					options.signal,
				);
				if (!settle) break;
			}
		}
		const pulled = await this.pull(client, document.uri, options.signal);
		const pushed = client.latestPublished(document.uri);
		const fresh = pushed !== undefined && pushed.seq > document.syncSeq ? pushed.diagnostics : [];
		const seen = new Set(pulled.diagnostics.map(diagnosticKey));
		const diagnostics = [
			...pulled.diagnostics,
			...fresh.filter((diagnostic) => !seen.has(diagnosticKey(diagnostic))),
		];
		return busyReason === undefined
			? { diagnostics, freshness: pulled.freshness }
			: { diagnostics, freshness: "unconfirmed", unconfirmedReason: busyReason };
	}

	private async push(
		client: LspClient,
		document: OpenDocument,
		options: DiagnosticRunOptions,
	): Promise<{ diagnostics: readonly Diagnostic[]; freshness: Freshness }> {
		const { uri } = document;
		const freshnessOf = (published: PublishedDiagnostics): Freshness =>
			published.version === null ? "observed" : "confirmed";
		const afterSync = (published: PublishedDiagnostics): boolean =>
			published.seq > document.syncSeq && (published.version === null || published.version >= document.version);
		const seenBefore = client.latestPublished(uri) !== undefined;

		// A server that already published this file may skip republishing unchanged results; nudge it by reopening.
		const published = await this.publishAfter(client, document, afterSync, seenBefore, options);
		if (published === "pull") return this.pull(client, uri, options.signal);
		if (published === null) {
			throw new ToolFailure(
				"timeout",
				`${client.target.server.id} published no diagnostics for ${uri} within ${options.timeoutMs}ms after the document was synced.`,
			);
		}
		const changedSince = client.lastWorkspaceChange;
		if (published.seq > changedSince)
			return { diagnostics: published.diagnostics, freshness: freshnessOf(published) };

		// Another file changed after this result was published, so it may be stale; ask for a fresh analysis.
		const after = (candidate: PublishedDiagnostics): boolean => candidate.seq > changedSince;
		const refreshed = await this.publishAfter(client, document, after, true, options);
		if (refreshed === "pull") return this.pull(client, uri, options.signal);
		return refreshed === null
			? { diagnostics: published.diagnostics, freshness: "unconfirmed" }
			: { diagnostics: refreshed.diagnostics, freshness: freshnessOf(refreshed) };
	}

	/**
	 * Waits for a publication `accept` takes. When the server may stay silent (`nudge`), it gets a short
	 * settle time and then a reopen; a server already known to stay silent is reopened right away.
	 */
	private async publishAfter(
		client: LspClient,
		document: OpenDocument,
		accept: (published: PublishedDiagnostics) => boolean,
		nudge: boolean,
		options: DiagnosticRunOptions,
	): Promise<PublishedDiagnostics | "pull" | null> {
		const reopenAndWait = async (): Promise<PublishedDiagnostics | "pull" | null> => {
			await this.documents.reopen(client, document);
			return client.waitForPublish(document.uri, accept, options.timeoutMs, options.signal);
		};
		if (!nudge) return client.waitForPublish(document.uri, accept, options.timeoutMs, options.signal);
		if (client.skipsUnchangedRepublish) return reopenAndWait();
		const settled = await client.waitForPublish(
			document.uri,
			accept,
			Math.min(DIAGNOSTICS_SETTLE_MS, options.timeoutMs),
			options.signal,
		);
		if (settled !== null) return settled;
		const reopened = await reopenAndWait();
		if (reopened !== null && reopened !== "pull") client.skipsUnchangedRepublish = true;
		return reopened;
	}
}
