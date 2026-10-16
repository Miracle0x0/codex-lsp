export { ConfigError, type ConfigIssue, type EffectiveConfig, loadEffectiveConfig } from "./config/loader.js";
export { ConfigFileSchema } from "./config/schema.js";
export {
	buildBatch,
	checkFiles,
	type DiagnosticBatch,
	formatBatch,
	formatBatchDiagnostic,
	providerFailed,
	type Severity,
} from "./diagnostics/batch.js";
export { DiagnosticBatchSchema } from "./diagnostics/batch-schema.js";
export type { FileChange, FileChangeKind } from "./documents/store.js";
export type { EnvironmentContext } from "./environment/service.js";
export {
	type CaptureInput,
	type CaptureResult,
	defaultStateDir,
	ENVIRONMENT_ID_PATTERN,
	EnvironmentIdSchema,
	type EnvironmentSnapshot,
	manifestPath,
	newEnvironmentId,
	readManifest,
	readSnapshot,
	selectVariables,
	writeSnapshot,
} from "./environment/snapshot.js";
export { snapshotVariableNames } from "./environment/variables.js";
export {
	createLspServerFactory,
	LSP_SERVER_INSTRUCTIONS,
	LSP_SERVER_NAME,
	type LspServerFactoryOptions,
	registerLspTools,
	serveLspStdio,
} from "./mcp/server.js";
export type { ContextResolver, HostCallContext, ToolCallContext } from "./runtime/context.js";
export type { FileTarget } from "./runtime/router.js";
export { createLspRuntime, LspRuntime, type LspRuntimeOptions } from "./runtime/runtime.js";
export {
	defineLspTool,
	type LspToolDefinition,
	type RegisteredLspTool,
	type ToolAnnotationHints,
	type ToolSuccess,
} from "./tools/definition.js";
export { type DiagnosticsInput, diagnoseFiles, type FileSetInput, runDiagnostics } from "./tools/diagnostics.js";
export { formatToolFailure, ToolFailure, type ToolFailureCode, toToolFailure } from "./tools/failures.js";
export { LSP_TOOLS } from "./tools/index.js";
export * as schemas from "./tools/schemas.js";
export { DEFAULT_EXCLUDED_DIRECTORIES, excludedDirectoryMatcher } from "./workspace/files.js";
export { FileChangeJournal, type JournalMark, type JournalOptions, type JournalWindow } from "./workspace/journal.js";
