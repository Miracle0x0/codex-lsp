import { readFileSync } from "node:fs";

import { type CallToolResult, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";

import type { ContextResolver, ToolCallContext } from "../runtime/context.js";
import type { LspRuntime } from "../runtime/runtime.js";
import type { RegisteredLspTool } from "../tools/definition.js";
import { formatToolFailure, toToolFailure } from "../tools/failures.js";
import { LSP_TOOLS } from "../tools/index.js";

export const LSP_SERVER_NAME = "lsp";

export const LSP_SERVER_INSTRUCTIONS = [
	"Language Server Protocol tools for the current workspace.",
	"Positions use a 1-based line and a 0-based character column counted in Unicode code points.",
	"Paths may be absolute or relative to the workspace root; pass workspaceRoot when the host does not provide one.",
	"Start with status when a language server is reported missing. Diagnostics report code problems as normal results;",
	"isError results mean the tool itself failed (server missing, crashed, timed out, or unsupported capability).",
	"Pass a handle from prepare_call_hierarchy to incoming_calls or outgoing_calls unchanged.",
	"Use prepare_rename before rename; rename writes files and must not run concurrently with other edits.",
].join(" ");

export interface LspServerFactoryOptions {
	readonly version?: string;
	/** Tools to register; defaults to the standard LSP tools. */
	readonly tools?: readonly RegisteredLspTool[];
	readonly resolveContext?: ContextResolver;
}

function packageVersion(): string {
	const raw: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
	if (typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string")
		return raw.version;
	throw new Error("lsp-tools-mcp package.json has no version");
}

function callContext(ctx: ServerContext, resolveContext: ContextResolver | undefined): ToolCallContext {
	return { ...(resolveContext?.(ctx.mcpReq._meta) ?? {}), signal: ctx.mcpReq.signal };
}

type ProgressReporter = (message: string) => Promise<void>;

/** Sends MCP progress notifications when the request asked for them with a progress token. */
function progressReporter(ctx: ServerContext): ProgressReporter | undefined {
	const token = ctx.mcpReq._meta?.progressToken;
	if (token === undefined) return undefined;
	let progress = 0;
	return async (message) => {
		ctx.mcpReq.signal.throwIfAborted();
		await ctx.mcpReq.notify({
			method: "notifications/progress",
			params: { progressToken: token, progress: ++progress, message },
		});
	};
}

async function runTool(
	runtime: LspRuntime,
	tool: RegisteredLspTool,
	args: unknown,
	context: ToolCallContext,
	reportProgress: ProgressReporter | undefined,
): Promise<CallToolResult> {
	try {
		await reportProgress?.(`Starting ${tool.name}`);
		const result = await tool.run(runtime, args, context);
		await reportProgress?.(`Completed ${tool.name}`);
		return {
			content: [{ type: "text", text: result.summary }],
			structuredContent: result.data,
			...(result.partial ? { isError: true } : {}),
		};
	} catch (error) {
		return { content: [{ type: "text", text: formatToolFailure(toToolFailure(error)) }], isError: true };
	}
}

export function registerLspTools(
	server: McpServer,
	runtime: LspRuntime,
	tools: readonly RegisteredLspTool[],
	resolveContext?: ContextResolver,
): void {
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				outputSchema: tool.outputSchema,
				annotations: tool.annotations,
			},
			async (args, ctx) => runTool(runtime, tool, args, callContext(ctx, resolveContext), progressReporter(ctx)),
		);
	}
}

/** Builds MCP server instances that all share one runtime. */
export function createLspServerFactory(runtime: LspRuntime, options: LspServerFactoryOptions = {}): () => McpServer {
	const version = options.version ?? packageVersion();
	return () => {
		const server = new McpServer({ name: LSP_SERVER_NAME, version }, { instructions: LSP_SERVER_INSTRUCTIONS });
		registerLspTools(server, runtime, options.tools ?? LSP_TOOLS, options.resolveContext);
		return server;
	};
}

/** Serves the 2026-07-28 MCP revision over stdio; 2025-era clients are rejected. */
export function serveLspStdio(runtime: LspRuntime, options: LspServerFactoryOptions = {}): StdioServerHandle {
	return serveStdio(createLspServerFactory(runtime, options), { legacy: "reject" });
}
