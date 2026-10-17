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
	async sync(client: LspClient, path: string, languageId: string): Promise<SyncedDocument> {
		const text = readDocument(path);
		const uri = pathToFileURL(path).href;
		const existing = client.documents.get(uri);
		if (existing === undefined) {
			const document: OpenDocument = { uri, path, languageId, version: 1, text, syncSeq: 0 };
			await client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
			document.syncSeq = client.nextSeq();
			client.documents.set(uri, document);
			return { document, opened: true };
		}
		if (existing.text !== text) await this.sendChange(client, existing, text);
		return { document: existing, opened: false };
	}

	private async sendChange(client: LspClient, document: OpenDocument, text: string): Promise<void> {
		const sync = client.textSync(document);
		document.version += 1;
		document.text = text;
		const { uri, languageId, version } = document;
		if (sync.change === 0) {
			// The server does not want change notifications; reopen it with the new content.
			await client.notify("textDocument/didClose", { textDocument: { uri } });
			await client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
		} else {
			await client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
		}
		if (sync.save) {
			await client.notify("textDocument/didSave", {
				textDocument: { uri },
				...(sync.saveIncludesText ? { text } : {}),
			});
		}
		document.syncSeq = client.nextSeq();
		client.markWorkspaceChange();
	}

	/** Closes and reopens a document so a push server analyzes and publishes it again. */
	async reopen(client: LspClient, document: OpenDocument): Promise<void> {
		const { uri, languageId } = document;
		await client.notify("textDocument/didClose", { textDocument: { uri } });
		// Servers may publish an empty result while closing (typescript-language-server does); the barrier
		// makes that arrive before the reopen, so it is never taken for the reopened document's result.
		await client.barrier();
		document.version += 1;
		await client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: document.version, text: document.text },
		});
		document.syncSeq = client.nextSeq();
	}

	async close(client: LspClient, uri: string): Promise<void> {
		if (!client.documents.delete(uri)) return;
		await client.notify("textDocument/didClose", { textDocument: { uri } });
	}

	/** Brings every client up to date after files changed on disk outside this client. */
	async applyFileChanges(clients: readonly LspClient[], changes: readonly FileChange[]): Promise<void> {
		if (changes.length === 0) return;
		await Promise.all(
			clients.map(async (client) => {
				for (const change of changes) {
					const uri = pathToFileURL(change.path).href;
					const document = client.documents.get(uri);
					if (document === undefined) continue;
					if (change.kind === "deleted") await this.close(client, uri);
					else await this.sendChange(client, document, readDocument(change.path));
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
