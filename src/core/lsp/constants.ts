export const DEFAULT_MAX_REFERENCES = 200;
export const DEFAULT_MAX_SYMBOLS = 200;
export const DEFAULT_MAX_DIAGNOSTICS = 200;

export const REQUEST_TIMEOUT_MS = 15_000;
/** A barrier request is answered by the JSON-RPC layer at once; past this the server is assumed not to answer them. */
export const BARRIER_TIMEOUT_MS = 2_000;
export const INIT_TIMEOUT_MS = 60_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const REAPER_INTERVAL_MS = 60_000;
// Leave headroom within Codex's two-second TERM-to-KILL window for the MCP process.
export const STOP_REQUEST_TIMEOUT_MS = 500;
export const STOP_TERM_TIMEOUT_MS = 500;
export const STOP_KILL_TIMEOUT_MS = 500;

/** How long a push-diagnostics server gets to publish for a synced document. */
export const DIAGNOSTICS_TIMEOUT_MS = 20_000;
/**
 * Wait for a republish before reopening a document. Servers such as typescript-language-server do not
 * republish a changed file whose diagnostics stayed the same; reopening makes them analyze it again.
 */
export const DIAGNOSTICS_SETTLE_MS = 1_500;
/**
 * Quiet time a pull server that reports work-done progress gets after a content change or after it went
 * idle; background checks (rust-analyzer starts cargo check about 100 ms after a save) begin within it.
 */
export const BACKGROUND_WORK_START_MS = 500;
/** Toolchain probe results are reused for this long within one environment generation. */
export const TOOLCHAIN_CACHE_TTL_MS = 30_000;
/** Documents checked at once per language server during directory diagnostics. */
export const DIAGNOSTICS_CONCURRENCY = 8;
/** Directories one file-change journal watches before it reports that changes may be missed. */
export const JOURNAL_MAX_DIRECTORIES = 4_096;
/** Raw watch events a journal retains; older windows are reported as incomplete. */
export const JOURNAL_MAX_EVENTS = 20_000;
/** Lets already-queued watch events dispatch before a window is read. */
export const JOURNAL_DRAIN_MS = 100;
/** Workspaces with a live file-change journal at once. */
export const JOURNAL_MAX_WORKSPACES = 4;
