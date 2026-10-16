import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	CreateFile,
	DeleteFile,
	RenameFile,
	TextDocumentEdit,
	TextEdit,
	WorkspaceEdit,
} from "vscode-languageserver-protocol";

import type { DocumentStore, FileChange } from "../documents/store.js";
import type { LspClient } from "../lsp/client.js";
import type { LspManager } from "../lsp/manager.js";
import { ToolFailure } from "../tools/failures.js";

type Operation =
	| {
			readonly kind: "text";
			readonly path: string;
			readonly uri: string;
			readonly version: number | null;
			readonly edits: readonly TextEdit[];
	  }
	| { readonly kind: "create"; readonly path: string; readonly overwrite: boolean; readonly ignoreIfExists: boolean }
	| {
			readonly kind: "rename";
			readonly from: string;
			readonly to: string;
			readonly overwrite: boolean;
			readonly ignoreIfExists: boolean;
	  }
	| {
			readonly kind: "delete";
			readonly path: string;
			readonly recursive: boolean;
			readonly ignoreIfNotExists: boolean;
	  };

export interface WorkspaceEditReport {
	readonly operationId: string;
	readonly applied: boolean;
	readonly changes: readonly FileChange[];
	readonly editCount: number;
	readonly completed: readonly string[];
	readonly failed: { readonly operation: string; readonly error: string } | undefined;
	readonly skipped: readonly string[];
}

function describe(operation: Operation): string {
	switch (operation.kind) {
		case "text":
			return `edit ${operation.path} (${operation.edits.length} change${operation.edits.length === 1 ? "" : "s"})`;
		case "create":
			return `create ${operation.path}`;
		case "rename":
			return `rename ${operation.from} -> ${operation.to}`;
		case "delete":
			return `delete ${operation.path}`;
	}
}

function isTextDocumentEdit(
	change: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
): change is TextDocumentEdit {
	return "textDocument" in change;
}

function toOperations(edit: WorkspaceEdit): Operation[] {
	if (edit.documentChanges !== undefined) {
		return edit.documentChanges.map((change): Operation => {
			if (isTextDocumentEdit(change)) {
				return {
					kind: "text",
					uri: change.textDocument.uri,
					path: fileURLToPath(change.textDocument.uri),
					version: change.textDocument.version ?? null,
					edits: change.edits.filter((item): item is TextEdit => "range" in item && "newText" in item),
				};
			}
			if (change.kind === "create") {
				return {
					kind: "create",
					path: fileURLToPath(change.uri),
					overwrite: change.options?.overwrite ?? false,
					ignoreIfExists: change.options?.ignoreIfExists ?? false,
				};
			}
			if (change.kind === "rename") {
				return {
					kind: "rename",
					from: fileURLToPath(change.oldUri),
					to: fileURLToPath(change.newUri),
					overwrite: change.options?.overwrite ?? false,
					ignoreIfExists: change.options?.ignoreIfExists ?? false,
				};
			}
			return {
				kind: "delete",
				path: fileURLToPath(change.uri),
				recursive: change.options?.recursive ?? false,
				ignoreIfNotExists: change.options?.ignoreIfNotExists ?? false,
			};
		});
	}
	return Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
		kind: "text" as const,
		uri,
		path: fileURLToPath(uri),
		version: null,
		edits,
	}));
}

function lineOffsets(text: string): number[] {
	const offsets = [0];
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === "\n") offsets.push(index + 1);
		else if (char === "\r") {
			if (text[index + 1] === "\n") index += 1;
			offsets.push(index + 1);
		}
	}
	return offsets;
}

/** Applies UTF-16 positioned edits (JavaScript string indices) after rejecting overlaps. */
export function applyTextEdits(text: string, edits: readonly TextEdit[], path: string): string {
	const offsets = lineOffsets(text);
	const offsetOf = (line: number, character: number): number => {
		const start = offsets[line];
		if (start === undefined) return text.length;
		const end = offsets[line + 1] ?? text.length;
		return Math.min(start + character, end);
	};
	const resolved = edits
		.map((edit, order) => ({
			start: offsetOf(edit.range.start.line, edit.range.start.character),
			end: offsetOf(edit.range.end.line, edit.range.end.character),
			newText: edit.newText,
			order,
		}))
		.sort((a, b) => a.start - b.start || a.order - b.order);
	for (let index = 1; index < resolved.length; index += 1) {
		const previous = resolved[index - 1];
		const current = resolved[index];
		if (previous !== undefined && current !== undefined && current.start < previous.end) {
			throw new ToolFailure("edit_failed", `Overlapping edits in ${path}; nothing was written.`);
		}
	}
	let result = text;
	for (const edit of [...resolved].reverse()) {
		result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
	}
	return result;
}

/** In-memory view of the files an edit touches, used to validate the whole edit before writing. */
class Simulation {
	private readonly contents = new Map<string, string | null>();

	read(path: string): string | null {
		if (this.contents.has(path)) return this.contents.get(path) ?? null;
		if (!existsSync(path)) return null;
		if (statSync(path).isDirectory()) return "";
		return readFileSync(path, "utf8");
	}

	exists(path: string): boolean {
		return this.read(path) !== null;
	}

	set(path: string, content: string | null): void {
		this.contents.set(path, content);
	}
}

/** The single write path for language-server edits; keeps every client in sync afterwards. */
export class WorkspaceEditCoordinator {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly manager: LspManager,
		private readonly documents: DocumentStore,
	) {}

	/** Edits run one at a time so concurrent tool calls never interleave writes. */
	apply(edit: WorkspaceEdit, origin: LspClient): Promise<WorkspaceEditReport> {
		const run = this.queue.then(() => this.applyNow(edit, origin));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private validate(operations: readonly Operation[], origin: LspClient): Map<Operation, string> {
		const simulation = new Simulation();
		const results = new Map<Operation, string>();
		for (const operation of operations) {
			switch (operation.kind) {
				case "text": {
					const current = simulation.read(operation.path);
					if (current === null)
						throw new ToolFailure("edit_failed", `Cannot edit missing file ${operation.path}.`);
					const document = origin.documents.get(operation.uri);
					if (operation.version !== null && document !== undefined && document.version !== operation.version) {
						throw new ToolFailure(
							"edit_failed",
							`${operation.path} changed since the server computed the edit (version ${operation.version}, now ${document.version}).`,
						);
					}
					if (document !== undefined && document.text !== current) {
						throw new ToolFailure(
							"edit_failed",
							`${operation.path} changed on disk since it was synced; re-run the operation.`,
						);
					}
					const next = applyTextEdits(current, operation.edits, operation.path);
					simulation.set(operation.path, next);
					results.set(operation, next);
					break;
				}
				case "create": {
					if (simulation.exists(operation.path) && !operation.overwrite && !operation.ignoreIfExists) {
						throw new ToolFailure("edit_failed", `Cannot create ${operation.path}: it already exists.`);
					}
					if (!simulation.exists(operation.path) || operation.overwrite) simulation.set(operation.path, "");
					break;
				}
				case "rename": {
					const content = simulation.read(operation.from);
					if (content === null) throw new ToolFailure("edit_failed", `Cannot rename missing ${operation.from}.`);
					if (simulation.exists(operation.to) && !operation.overwrite && !operation.ignoreIfExists) {
						throw new ToolFailure("edit_failed", `Cannot rename to ${operation.to}: it already exists.`);
					}
					simulation.set(operation.to, content);
					simulation.set(operation.from, null);
					break;
				}
				case "delete": {
					if (!simulation.exists(operation.path) && !operation.ignoreIfNotExists) {
						throw new ToolFailure("edit_failed", `Cannot delete missing ${operation.path}.`);
					}
					simulation.set(operation.path, null);
					break;
				}
			}
		}
		return results;
	}

	private execute(operation: Operation, text: string | undefined): FileChange[] {
		switch (operation.kind) {
			case "text":
				writeFileSync(operation.path, text ?? "", "utf8");
				return [{ path: operation.path, kind: "changed" }];
			case "create": {
				const existed = existsSync(operation.path);
				if (existed && !operation.overwrite) return [];
				mkdirSync(dirname(operation.path), { recursive: true });
				writeFileSync(operation.path, "", "utf8");
				return [{ path: operation.path, kind: existed ? "changed" : "created" }];
			}
			case "rename": {
				if (existsSync(operation.to) && !operation.overwrite) return [];
				mkdirSync(dirname(operation.to), { recursive: true });
				renameSync(operation.from, operation.to);
				return [
					{ path: operation.from, kind: "deleted" },
					{ path: operation.to, kind: "created" },
				];
			}
			case "delete":
				if (!existsSync(operation.path)) return [];
				rmSync(operation.path, { recursive: operation.recursive });
				return [{ path: operation.path, kind: "deleted" }];
		}
	}

	private async applyNow(edit: WorkspaceEdit, origin: LspClient): Promise<WorkspaceEditReport> {
		const operationId = randomUUID();
		const operations = toOperations(edit);
		const planned = this.validate(operations, origin);
		const changes: FileChange[] = [];
		const completed: string[] = [];
		let failed: WorkspaceEditReport["failed"];
		let editCount = 0;
		for (const [index, operation] of operations.entries()) {
			try {
				changes.push(...this.execute(operation, planned.get(operation)));
				completed.push(describe(operation));
				if (operation.kind === "text") editCount += operation.edits.length;
			} catch (error) {
				failed = { operation: describe(operation), error: error instanceof Error ? error.message : String(error) };
				const skipped = operations.slice(index + 1).map(describe);
				await this.documents.applyFileChanges(this.manager.activeClients(), changes);
				return { operationId, applied: false, changes, editCount, completed, failed, skipped };
			}
		}
		await this.documents.applyFileChanges(this.manager.activeClients(), changes);
		return { operationId, applied: true, changes, editCount, completed, failed, skipped: [] };
	}
}
