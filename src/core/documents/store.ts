import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { LspClient, OpenDocument } from "../lsp/client.js";
import { ToolFailure } from "../tools/failures.js";

export const FILE_CHANGE_KINDS = ["created", "changed", "deleted"] as const;
export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number];

export interface FileChange {
	readonly path: string;
	readonly kind: FileChangeKind;
}

export interface SyncedDocument {
	readonly document: OpenDocument;
	/** True when this call sent didOpen (the document was not open in this client before). */
	readonly opened: boolean;
}

interface DocumentAccess {
	users: number;
	/** Orders open/change/close notifications without serializing semantic requests. */
	ready: Promise<void>;
}

const FILE_CHANGE_TYPE: Readonly<Record<FileChangeKind, number>> = { created: 1, changed: 2, deleted: 3 };

function readDocument(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new ToolFailure(
			"invalid_path",
			`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Keeps each client's view of documents equal to the files on disk. Changes are sent as full-text
 * updates, which servers accept for both full and incremental sync.
 */
export class DocumentStore {
	private readonly accesses = new WeakMap<LspClient, Map<string, DocumentAccess>>();

	/** A request owns the document until it finishes; overlapping requests share its open lifetime. */
	async withDocument<T>(
		client: LspClient,
		path: string,
		languageId: string,
		operation: (synced: SyncedDocument) => Promise<T>,
	): Promise<T> {
		const uri = pathToFileURL(path).href;
		let entries = this.accesses.get(client);
		if (entries === undefined) {
			entries = new Map();
			this.accesses.set(client, entries);
		}
		let access = entries.get(uri);
		if (access === undefined) {
			access = { users: 0, ready: Promise.resolve() };
			entries.set(uri, access);
		}
		access.users += 1;
		try {
			const synced = await this.serialize(access, () => this.sync(client, path, languageId));
			return await operation(synced);
		} finally {
			access.users -= 1;
			if (access.users === 0) {
				const owned = access;
				const documents = entries;
				await this.serialize(owned, async () => {
					if (owned.users !== 0) return;
					try {
						await this.close(client, uri);
					} finally {
						// A request arriving during close waits on this same entry before reopening.
						if (owned.users === 0) documents.delete(uri);
					}
				});
			}
		}
	}

	private async serialize<T>(access: DocumentAccess, operation: () => Promise<T>): Promise<T> {
		const previous = access.ready;
		let release!: () => void;
		access.ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private async sync(client: LspClient, path: string, languageId: string): Promise<SyncedDocument> {
		const text = readDocument(path);
		const uri = pathToFileURL(path).href;
		const existing = client.documents.get(uri);
		if (existing === undefined) {
			// A client-wide sequence avoids retaining a version counter for every previously visited URI.
			const version = client.nextSeq();
			const document: OpenDocument = { uri, path, languageId, version, text, syncSeq: client.nextSeq() };
			client.documents.set(uri, document);
			if (client.textSync(document).openClose) {
				await client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
			}
			return { document, opened: true };
		}
		if (existing.text !== text) await this.sendChange(client, existing, text);
		return { document: existing, opened: false };
	}

	private async sendChange(client: LspClient, document: OpenDocument, text: string): Promise<void> {
		const sync = client.textSync(document);
		document.version = client.nextSeq();
		document.text = text;
		client.markWorkspaceChange();
		document.syncSeq = client.nextSeq();
		const { uri, languageId, version } = document;
		if (sync.change === 0) {
			// The server does not want change notifications; reopen it with the new content.
			if (sync.openClose) {
				await client.notify("textDocument/didClose", { textDocument: { uri } });
				await client.barrier();
				client.clearDiagnostics(uri);
				document.syncSeq = client.nextSeq();
				await client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
			}
		} else {
			await client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
		}
		await this.save(client, document);
	}

	/** The requested diagnostics describe saved disk contents, including checks a server runs on save. */
	async save(client: LspClient, document: OpenDocument): Promise<void> {
		const sync = client.textSync(document);
		if (sync.save) {
			await client.notify("textDocument/didSave", {
				textDocument: { uri: document.uri },
				...(sync.saveIncludesText ? { text: document.text } : {}),
			});
		}
	}

	/** Closes and reopens a document so a push server analyzes and publishes it again. */
	async reopen(client: LspClient, document: OpenDocument): Promise<void> {
		const access = this.accesses.get(client)?.get(document.uri);
		if (access === undefined) throw new Error(`Cannot reopen an unowned document: ${document.uri}`);
		await this.serialize(access, () => this.reopenDocument(client, document));
	}

	private async reopenDocument(client: LspClient, document: OpenDocument): Promise<void> {
		if (!client.textSync(document).openClose) return;
		const { uri, languageId } = document;
		await client.notify("textDocument/didClose", { textDocument: { uri } });
		// Servers may publish an empty result while closing (typescript-language-server does); the barrier
		// makes that arrive before the reopen, so it is never taken for the reopened document's result.
		await client.barrier();
		client.clearDiagnostics(uri);
		document.version = client.nextSeq();
		document.syncSeq = client.nextSeq();
		await client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: document.version, text: document.text },
		});
	}

	private async close(client: LspClient, uri: string): Promise<void> {
		const document = client.documents.get(uri);
		client.documents.delete(uri);
		client.clearDiagnostics(uri);
		if (document !== undefined && client.textSync(document).openClose) {
			await client.notify("textDocument/didClose", { textDocument: { uri } });
			// Drain close-time publications before a new owner can reopen this URI.
			await client.barrier();
		}
	}

	/** Brings every client up to date after files changed on disk outside this client. */
	async applyFileChanges(clients: readonly LspClient[], changes: readonly FileChange[]): Promise<void> {
		if (changes.length === 0) return;
		await Promise.all(
			clients.map(async (client) => {
				for (const change of changes) {
					const uri = pathToFileURL(change.path).href;
					const access = this.accesses.get(client)?.get(uri);
					if (access === undefined) continue;
					await this.serialize(access, async () => {
						const document = client.documents.get(uri);
						if (document === undefined) return;
						if (change.kind === "deleted") await this.close(client, uri);
						else await this.sendChange(client, document, readDocument(change.path));
					});
				}
				if (client.watchesFiles()) {
					await client.notify("workspace/didChangeWatchedFiles", {
						changes: changes.map((change) => ({
							uri: pathToFileURL(change.path).href,
							type: FILE_CHANGE_TYPE[change.kind],
						})),
					});
				}
				client.markWorkspaceChange();
			}),
		);
	}
}
