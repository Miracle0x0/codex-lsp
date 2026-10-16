import { ResponseError } from "vscode-jsonrpc/node";
import { ConfigError } from "../config/loader.js";
import {
	LspConnectionClosedError,
	LspInvalidPathError,
	LspProcessExitedError,
	LspProcessSpawnError,
	LspRequestCancelledError,
	LspRequestTimeoutError,
	LspServerStartError,
} from "../lsp/errors.js";
import { formatKnownLspStartupFailure } from "../lsp/utils.js";

const METHOD_NOT_FOUND = -32601;

export type ToolFailureCode =
	| "invalid_input"
	| "invalid_path"
	| "config_invalid"
	| "environment_error"
	| "server_not_configured"
	| "server_not_installed"
	| "server_start_failed"
	| "server_exited"
	| "timeout"
	| "cancelled"
	| "capability_unsupported"
	| "request_failed"
	| "edit_failed"
	| "internal_error";

/** A tool execution failure, as opposed to a successful result that reports code problems. */
export class ToolFailure extends Error {
	override readonly name = "ToolFailure";

	constructor(
		readonly code: ToolFailureCode,
		message: string,
	) {
		super(message);
	}
}

export function toToolFailure(error: unknown): ToolFailure {
	if (error instanceof ToolFailure) return error;
	if (error instanceof ConfigError) return new ToolFailure("config_invalid", error.message);
	if (error instanceof LspInvalidPathError) return new ToolFailure("invalid_path", error.message);
	if (error instanceof LspProcessExitedError) {
		return new ToolFailure("server_exited", formatKnownLspStartupFailure(error) ?? error.message);
	}
	if (error instanceof LspConnectionClosedError) return new ToolFailure("server_exited", error.message);
	if (error instanceof LspProcessSpawnError) return new ToolFailure("server_start_failed", error.message);
	if (error instanceof LspServerStartError) return new ToolFailure("server_start_failed", error.message);
	if (error instanceof LspRequestTimeoutError) return new ToolFailure("timeout", error.message);
	if (error instanceof LspRequestCancelledError || isAbortError(error)) {
		return new ToolFailure("cancelled", error instanceof Error ? error.message : "Request cancelled");
	}
	if (error instanceof ResponseError) {
		if (error.code === METHOD_NOT_FOUND) return new ToolFailure("capability_unsupported", error.message);
		return new ToolFailure("request_failed", `Language server error ${error.code}: ${error.message}`);
	}
	if (isSpawnError(error)) return new ToolFailure("server_start_failed", error.message);
	return new ToolFailure("internal_error", error instanceof Error ? error.message : String(error));
}

export function formatToolFailure(failure: ToolFailure): string {
	return `[${failure.code}] ${failure.message}`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isSpawnError(error: unknown): error is Error {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
}
