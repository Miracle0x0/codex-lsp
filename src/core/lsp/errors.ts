export class LspConnectionClosedError extends Error {
	override readonly name = "LspConnectionClosedError";

	constructor(
		readonly serverId: string,
		readonly root: string,
		message?: string,
	) {
		super(message ?? `LSP connection closed for ${serverId} at ${root}`);
	}
}

export class LspProcessExitedError extends Error {
	override readonly name = "LspProcessExitedError";

	constructor(
		readonly serverId: string,
		readonly root: string,
		readonly exitCode: number | null,
		readonly stderrTail?: string,
	) {
		const stderrSuffix = stderrTail ? `\nstderr tail: ${stderrTail}` : "";
		super(`LSP server ${serverId} at ${root} exited with code ${exitCode ?? "null"}${stderrSuffix}`);
	}
}

/** The server process started but the initialize handshake failed. */
export class LspServerStartError extends Error {
	override readonly name = "LspServerStartError";

	constructor(
		readonly serverId: string,
		readonly root: string,
		reason: string,
		readonly stderrTail?: string,
	) {
		const stderrSuffix = stderrTail ? `\nstderr tail: ${stderrTail}` : "";
		super(`LSP server ${serverId} failed to initialize at ${root}: ${reason}${stderrSuffix}`);
	}
}

export class LspRequestTimeoutError extends Error {
	override readonly name = "LspRequestTimeoutError";

	constructor(
		readonly method: string,
		readonly stderrTail?: string,
	) {
		const stderrSuffix = stderrTail ? `\nrecent stderr: ${stderrTail}` : "";
		super(`LSP request timeout (method: ${method})${stderrSuffix}`);
	}
}

export class LspRequestCancelledError extends Error {
	override readonly name = "LspRequestCancelledError";

	constructor(readonly method: string) {
		super(`LSP request cancelled (method: ${method})`);
	}
}

export class LspProcessSpawnError extends Error {
	override readonly name = "LspProcessSpawnError";
}

export class LspInvalidPathError extends Error {
	override readonly name = "LspInvalidPathError";
}

export function isLspDeadConnectionError(err: unknown): err is LspConnectionClosedError | LspProcessExitedError {
	return err instanceof LspConnectionClosedError || err instanceof LspProcessExitedError;
}
