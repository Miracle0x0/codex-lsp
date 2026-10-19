export function reportBestEffortCleanupError(operation: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[codex-lsp] ${operation} failed during cleanup: ${message}`);
}
