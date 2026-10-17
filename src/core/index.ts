// The core surface the Codex adapter and the CLI use; everything else stays internal to src/core/.
export { configSourcesOf, loadEffectiveConfig } from "./config/loader.js";
export { type DiagnosticBatch, formatBatchDiagnostic, type Severity } from "./diagnostics/batch.js";
export { DiagnosticBatchSchema } from "./diagnostics/batch-schema.js";
export { FILE_CHANGE_KINDS, type FileChange } from "./documents/store.js";
export {
	type CaptureResult,
	defaultStateDir,
	ENVIRONMENT_ID_PATTERN,
	manifestPath,
	newEnvironmentId,
	readManifest,
	readSnapshot,
	writeSnapshot,
} from "./environment/snapshot.js";
export { serveLspStdio } from "./mcp/server.js";
export type { ContextResolver, HostCallContext } from "./runtime/context.js";
export { createLspRuntime, type LspRuntime } from "./runtime/runtime.js";
export { defineLspTool, type RegisteredLspTool } from "./tools/definition.js";
export { formatToolFailure, toToolFailure } from "./tools/failures.js";
export { LSP_TOOLS } from "./tools/index.js";
export type { FileChangeJournal, JournalMark } from "./workspace/journal.js";
