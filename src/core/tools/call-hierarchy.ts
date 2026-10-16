import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
	CallHierarchyIncomingCall,
	CallHierarchyItem,
	CallHierarchyOutgoingCall,
} from "vscode-languageserver-protocol";
import * as z from "zod";

import { uriToPath } from "../documents/positions.js";
import { EnvironmentIdSchema } from "../environment/snapshot.js";
import type { ToolCallContext } from "../runtime/context.js";
import type { LspRuntime, SemanticSession } from "../runtime/runtime.js";
import { defineLspTool, type ToolSuccess } from "./definition.js";
import { ToolFailure } from "./failures.js";
import { NAVIGATION_ANNOTATIONS, positionParams, symbolKindName } from "./navigation.js";
import { PositionInputShape, RangeSchema } from "./schemas.js";

function isFileUri(value: string): boolean {
	try {
		uriToPath(value);
		return true;
	} catch {
		return false;
	}
}

const LspPositionSchema = z.object({ line: z.number().int().min(0), character: z.number().int().min(0) });
const LspRangeSchema = z.object({ start: LspPositionSchema, end: LspPositionSchema });

/** Wire shape of an LSP CallHierarchyItem; `data` is server-private and returned untouched. */
const LspCallHierarchyItemSchema = z.object({
	name: z.string(),
	kind: z.number().int(),
	tags: z.array(z.number().int()).optional(),
	detail: z.string().optional(),
	uri: z.string().refine(isFileUri, "item uri must be a file URI"),
	range: LspRangeSchema,
	selectionRange: LspRangeSchema,
	data: z.unknown().optional(),
});

/**
 * Everything needed to send an item back to the server instance that produced it: the item is only
 * meaningful to that server, in that workspace and environment.
 */
const HandlePayloadSchema = z.strictObject({
	v: z.literal(2),
	server: z.string().min(1),
	workspaceRoot: z.string().refine(isAbsolute, "workspaceRoot must be absolute").nullable(),
	environmentId: EnvironmentIdSchema.nullable(),
	item: LspCallHierarchyItemSchema,
	clientId: z.string(),
	targetKey: z.string(),
	environmentKey: z.string(),
	contentHash: z.string(),
});
const HandleSchema = HandlePayloadSchema.extend({ signature: z.string().regex(/^[0-9a-f]{64}$/) });

type Handle = z.infer<typeof HandleSchema>;

const MAX_HANDLE_LENGTH = 65_536;
const secrets = new WeakMap<LspRuntime, Buffer>();

function fileHash(uri: string): string {
	return createHash("sha256")
		.update(readFileSync(uriToPath(uri)))
		.digest("hex");
}

function encodeHandle(runtime: LspRuntime, session: SemanticSession, item: CallHierarchyItem): string {
	let secret = secrets.get(runtime);
	if (secret === undefined) {
		secret = randomBytes(32);
		secrets.set(runtime, secret);
	}
	const payload = HandlePayloadSchema.parse({
		v: 2,
		server: session.client.target.server.id,
		workspaceRoot: session.file.workspaceRoot ?? null,
		environmentId: session.file.environment.environmentId,
		item,
		clientId: session.client.instanceId,
		targetKey: session.client.target.key,
		environmentKey: session.file.environment.key,
		contentHash: fileHash(item.uri),
	});
	const signature = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
	const handle: Handle = { ...payload, signature };
	return Buffer.from(JSON.stringify(handle), "utf8").toString("base64url");
}

function decodeHandle(runtime: LspRuntime, value: string): Handle {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new ToolFailure(
			"invalid_input",
			"'item' is not a call hierarchy handle returned by prepare_call_hierarchy",
		);
	}
	const result = HandleSchema.safeParse(parsed);
	if (!result.success) {
		throw new ToolFailure(
			"invalid_input",
			`'item' is not a valid call hierarchy handle: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
		);
	}
	const { signature, ...payload } = result.data;
	const secret = secrets.get(runtime);
	if (
		secret === undefined ||
		!timingSafeEqual(
			Buffer.from(signature, "hex"),
			createHmac("sha256", secret).update(JSON.stringify(payload)).digest(),
		)
	)
		throw new ToolFailure(
			"invalid_input",
			"Call hierarchy handle was modified or belongs to another runtime; run prepare_call_hierarchy again.",
		);
	return result.data;
}

export const CallItemSchema = z.object({
	handle: z.string().describe("Opaque handle to pass to incoming_calls or outgoing_calls."),
	name: z.string(),
	kind: z.string(),
	detail: z.string().optional(),
	path: z.string(),
	range: RangeSchema.describe("Range of the item's name."),
});

type CallItem = z.infer<typeof CallItemSchema>;

function toCallItem(runtime: LspRuntime, session: SemanticSession, item: CallHierarchyItem): CallItem {
	const path = uriToPath(item.uri);
	return {
		handle: encodeHandle(runtime, session, item),
		name: item.name,
		kind: symbolKindName(item.kind),
		...(item.detail ? { detail: item.detail } : {}),
		path,
		range: session.positions.toPublicRange(path, item.selectionRange),
	};
}

function formatCallItem(item: CallItem): string {
	const detail = item.detail ? ` ${item.detail}` : "";
	return `${item.name} (${item.kind})${detail} - ${item.path}:${item.range.start.line}:${item.range.start.character}`;
}

const CALL_HIERARCHY_CAPABILITY = "callHierarchyProvider";

export const PrepareCallHierarchyOutputSchema = z.object({ server: z.string(), items: z.array(CallItemSchema) });

export const prepareCallHierarchyTool = defineLspTool({
	name: "prepare_call_hierarchy",
	title: "LSP Prepare Call Hierarchy",
	description:
		"Resolve the function or method at a position to call hierarchy items; pass an item's handle to incoming_calls or outgoing_calls.",
	annotations: NAVIGATION_ANNOTATIONS,
	inputSchema: z.object(PositionInputShape),
	outputSchema: PrepareCallHierarchyOutputSchema,
	async run(runtime, input, context) {
		const file = runtime.file(input, context);
		return runtime.withSemantic(
			file,
			{
				server: input.server,
				signal: context.signal,
				readOnly: true,
				capability: CALL_HIERARCHY_CAPABILITY,
				method: "textDocument/prepareCallHierarchy",
			},
			async (session) => {
				const result = await session.client.request<CallHierarchyItem[] | null>(
					"textDocument/prepareCallHierarchy",
					positionParams(session, input),
					context.signal,
				);
				const items = (result ?? []).map((item) => toCallItem(runtime, session, item));
				return {
					summary:
						items.length === 0 ? "No call hierarchy item at this position" : items.map(formatCallItem).join("\n"),
					data: { server: session.client.target.server.id, items },
				};
			},
		);
	},
});

const CallsInputSchema = z.object({
	item: z
		.string()
		.min(1)
		.max(MAX_HANDLE_LENGTH)
		.describe("Handle of a call hierarchy item from prepare_call_hierarchy, incoming_calls, or outgoing_calls."),
});

const CallSchema = z.object({
	item: CallItemSchema,
	fromRanges: z.array(RangeSchema).describe("Call sites, in the calling item's file."),
});

type Call = z.infer<typeof CallSchema>;

export const CallsOutputSchema = z.object({ server: z.string(), calls: z.array(CallSchema) });

/** Sends a handle back to the server instance, workspace, and environment that produced it. */
async function hierarchyCalls(
	runtime: LspRuntime,
	value: string,
	context: ToolCallContext,
	direction: "incoming" | "outgoing",
): Promise<ToolSuccess<z.infer<typeof CallsOutputSchema>>> {
	const handle = decodeHandle(runtime, value);
	const original = runtime.manager.activeClients().find((client) => client.instanceId === handle.clientId);
	const stale = (): never => {
		throw new ToolFailure("invalid_input", "Call hierarchy context changed; run prepare_call_hierarchy again.");
	};
	if (original === undefined || fileHash(handle.item.uri) !== handle.contentHash) stale();
	const file = runtime.fileIn(uriToPath(handle.item.uri), handle.workspaceRoot ?? undefined, handle.environmentId);
	if (file.environment.key !== handle.environmentKey) stale();
	const method = `callHierarchy/${direction}Calls`;
	return runtime.withSemantic(
		file,
		{ server: handle.server, signal: context.signal, readOnly: true, capability: CALL_HIERARCHY_CAPABILITY, method },
		async (session) => {
			if (session.client.instanceId !== handle.clientId || session.client.target.key !== handle.targetKey) stale();
			let calls: Call[];
			if (direction === "incoming") {
				const result = await session.client.request<CallHierarchyIncomingCall[] | null>(
					method,
					{ item: handle.item },
					context.signal,
				);
				calls = (result ?? []).map((call) => {
					const caller = toCallItem(runtime, session, call.from);
					return {
						item: caller,
						fromRanges: call.fromRanges.map((range) => session.positions.toPublicRange(caller.path, range)),
					};
				});
			} else {
				const result = await session.client.request<CallHierarchyOutgoingCall[] | null>(
					method,
					{ item: handle.item },
					context.signal,
				);
				calls = (result ?? []).map((call) => ({
					item: toCallItem(runtime, session, call.to),
					fromRanges: call.fromRanges.map((range) => session.positions.toPublicRange(file.path, range)),
				}));
			}
			const summary =
				calls.length === 0
					? `No ${direction} calls for ${handle.item.name}`
					: calls
							.map((call) =>
								[
									formatCallItem(call.item),
									...call.fromRanges.map((range) => `  at line ${range.start.line}:${range.start.character}`),
								].join("\n"),
							)
							.join("\n");
			return { summary, data: { server: session.client.target.server.id, calls } };
		},
	);
}

export const incomingCallsTool = defineLspTool({
	name: "incoming_calls",
	title: "LSP Incoming Calls",
	description: "List the callers of a call hierarchy item, with the call sites in each caller.",
	annotations: NAVIGATION_ANNOTATIONS,
	inputSchema: CallsInputSchema,
	outputSchema: CallsOutputSchema,
	run: (runtime, input, context) => hierarchyCalls(runtime, input.item, context, "incoming"),
});

export const outgoingCallsTool = defineLspTool({
	name: "outgoing_calls",
	title: "LSP Outgoing Calls",
	description: "List what a call hierarchy item calls, with the call sites inside the item.",
	annotations: NAVIGATION_ANNOTATIONS,
	inputSchema: CallsInputSchema,
	outputSchema: CallsOutputSchema,
	run: (runtime, input, context) => hierarchyCalls(runtime, input.item, context, "outgoing"),
});
