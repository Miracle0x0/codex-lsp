import type {
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	MarkedString,
	ServerCapabilities,
	SymbolInformation,
	TextDocumentPositionParams,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import * as z from "zod";

import { uriToPath } from "../documents/positions.js";
import { DEFAULT_MAX_REFERENCES, DEFAULT_MAX_SYMBOLS } from "../lsp/constants.js";
import { SYMBOL_KIND_MAP } from "../lsp/language-mappings.js";
import type { SemanticSession } from "../runtime/runtime.js";
import { defineLspTool } from "./definition.js";
import { ToolFailure } from "./failures.js";
import { formatPublicLocation, toLocationList } from "./locations.js";
import { FileInputShape, LocationSchema, PositionInputShape, RangeSchema, ServerInputShape } from "./schemas.js";

export const NAVIGATION_ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export function positionParams(
	session: SemanticSession,
	position: { readonly line: number; readonly character: number },
): TextDocumentPositionParams {
	return {
		textDocument: { uri: session.file.uri },
		position: session.positions.toLsp(session.file.path, position),
	};
}

export function symbolKindName(kind: number): string {
	return SYMBOL_KIND_MAP[kind] ?? `Unknown(${kind})`;
}

export const LocationsOutputSchema = z.object({ server: z.string(), locations: z.array(LocationSchema) });

function locationTool(spec: {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly capability: keyof ServerCapabilities;
	readonly method: string;
	readonly empty: string;
}) {
	return defineLspTool({
		name: spec.name,
		title: spec.title,
		description: spec.description,
		annotations: NAVIGATION_ANNOTATIONS,
		inputSchema: z.object(PositionInputShape),
		outputSchema: LocationsOutputSchema,
		async run(runtime, input, context) {
			const file = runtime.file(input, context);
			return runtime.withSemantic(
				file,
				{
					server: input.server,
					signal: context.signal,
					readOnly: true,
					capability: spec.capability,
					method: spec.method,
				},
				async (session) => {
					const result = await session.client.request<Location | LocationLink[] | Location[] | null>(
						spec.method,
						positionParams(session, input),
						context.signal,
					);
					const locations = toLocationList(result, session.positions);
					return {
						summary: locations.length === 0 ? spec.empty : locations.map(formatPublicLocation).join("\n"),
						data: { server: session.client.target.server.id, locations },
					};
				},
			);
		},
	});
}

export const gotoDefinitionTool = locationTool({
	name: "goto_definition",
	title: "LSP Goto Definition",
	description: "Find where the symbol at a position is defined.",
	capability: "definitionProvider",
	method: "textDocument/definition",
	empty: "No definition found",
});

export const gotoImplementationTool = locationTool({
	name: "goto_implementation",
	title: "LSP Goto Implementation",
	description: "Find implementations of the interface, abstract member, or type at a position.",
	capability: "implementationProvider",
	method: "textDocument/implementation",
	empty: "No implementation found",
});

const HoverSchema = z.object({
	kind: z.enum(["markdown", "plaintext"]),
	contents: z.string(),
	range: RangeSchema.optional().describe("Range of the hovered symbol, when the server reports one."),
});

type HoverOutput = z.infer<typeof HoverSchema>;

export const HoverOutputSchema = z.object({ server: z.string(), hover: HoverSchema.nullable() });

function markedText(value: MarkedString): string {
	return typeof value === "string" ? value : `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

/** Normalizes MarkupContent and the deprecated MarkedString forms to one text block. */
function hoverContents(contents: Hover["contents"]): Pick<HoverOutput, "kind" | "contents"> {
	if (Array.isArray(contents)) return { kind: "markdown", contents: contents.map(markedText).join("\n\n") };
	if (typeof contents === "object" && "kind" in contents) return { kind: contents.kind, contents: contents.value };
	return { kind: "markdown", contents: markedText(contents) };
}

export const hoverTool = defineLspTool({
	name: "hover",
	title: "LSP Hover",
	description: "Show type information and documentation for the symbol at a position.",
	annotations: NAVIGATION_ANNOTATIONS,
	inputSchema: z.object(PositionInputShape),
	outputSchema: HoverOutputSchema,
	async run(runtime, input, context) {
		const file = runtime.file(input, context);
		return runtime.withSemantic(
			file,
			{
				server: input.server,
				signal: context.signal,
				readOnly: true,
				capability: "hoverProvider",
				method: "textDocument/hover",
			},
			async (session) => {
				const result = await session.client.request<Hover | null>(
					"textDocument/hover",
					positionParams(session, input),
					context.signal,
				);
				const normalized = result === null ? undefined : hoverContents(result.contents);
				const hover =
					normalized === undefined || normalized.contents.trim() === ""
						? null
						: {
								...normalized,
								...(result?.range ? { range: session.positions.toPublicRange(file.path, result.range) } : {}),
							};
				return {
					summary: hover === null ? "No hover information" : hover.contents,
					data: { server: session.client.target.server.id, hover },
				};
			},
		);
	},
});

export const findReferencesTool = defineLspTool({
	name: "find_references",
	title: "LSP Find References",
	description: "Find references to the symbol at a position across the workspace.",
	annotations: NAVIGATION_ANNOTATIONS,
	inputSchema: z.object({
		...PositionInputShape,
		includeDeclaration: z.boolean().default(true).describe("Include the declaration itself."),
		limit: z.number().int().min(1).default(DEFAULT_MAX_REFERENCES).describe("Maximum references to return."),
	}),
	outputSchema: z.object({
		server: z.string(),
		references: z.array(LocationSchema),
		total: z.number().int(),
		truncated: z.boolean(),
	}),
	async run(runtime, input, context) {
		const file = runtime.file(input, context);
		return runtime.withSemantic(
			file,
			{
				server: input.server,
				signal: context.signal,
				readOnly: true,
				capability: "referencesProvider",
				method: "textDocument/references",
			},
			async (session) => {
				const result = await session.client.request<Location[] | null>(
					"textDocument/references",
					{ ...positionParams(session, input), context: { includeDeclaration: input.includeDeclaration } },
					context.signal,
				);
				const all = toLocationList(result, session.positions);
				const references = all.slice(0, input.limit);
				const truncated = all.length > references.length;
				const summary =
					all.length === 0
						? "No references found"
						: [
								...(truncated ? [`Found ${all.length} references (showing first ${references.length}):`] : []),
								...references.map(formatPublicLocation),
							].join("\n");
				return {
					summary,
					data: { server: session.client.target.server.id, references, total: all.length, truncated },
				};
			},
		);
	},
});

const SymbolOutputSchema = z.object({
	name: z.string(),
	kind: z.string(),
	depth: z.number().int().describe("Nesting depth in the document outline; 0 for workspace symbols."),
	path: z.string(),
	range: RangeSchema.optional().describe("Absent when a workspace symbol only names its file."),
	containerName: z.string().optional(),
});

type SymbolOutput = z.infer<typeof SymbolOutputSchema>;

function isDocumentSymbol(symbol: DocumentSymbol | SymbolInformation): symbol is DocumentSymbol {
	return "selectionRange" in symbol;
}

function flattenDocumentSymbols(
	symbols: readonly DocumentSymbol[],
	path: string,
	session: SemanticSession,
	depth = 0,
): SymbolOutput[] {
	return symbols.flatMap((symbol) => [
		{
			name: symbol.name,
			kind: symbolKindName(symbol.kind),
			depth,
			path,
			range: session.positions.toPublicRange(path, symbol.selectionRange),
		},
		...flattenDocumentSymbols(symbol.children ?? [], path, session, depth + 1),
	]);
}

function fromSymbolInformation(symbol: SymbolInformation | WorkspaceSymbol, session: SemanticSession): SymbolOutput {
	const path = uriToPath(symbol.location.uri);
	return {
		name: symbol.name,
		kind: symbolKindName(symbol.kind),
		depth: 0,
		path,
		...("range" in symbol.location ? { range: session.positions.toPublicRange(path, symbol.location.range) } : {}),
		...(symbol.containerName ? { containerName: symbol.containerName } : {}),
	};
}

function formatSymbol(symbol: SymbolOutput): string {
	const container = symbol.containerName ? ` (in ${symbol.containerName})` : "";
	const line = symbol.range ? `:${symbol.range.start.line}` : "";
	return `${"  ".repeat(symbol.depth)}${symbol.name} (${symbol.kind})${container} - ${symbol.path}${line}`;
}

export const symbolsTool = defineLspTool({
	name: "symbols",
	title: "LSP Symbols",
	description: "List the symbols of a document, or search workspace symbols by query.",
	annotations: NAVIGATION_ANNOTATIONS,
	inputSchema: z.object({
		...FileInputShape,
		filePath: FileInputShape.filePath.describe(
			"File used as LSP context; its symbols are listed for document scope.",
		),
		...ServerInputShape,
		scope: z.enum(["document", "workspace"]).default("document"),
		query: z.string().min(1).optional().describe("Workspace symbol query; required for workspace scope."),
		limit: z.number().int().min(1).default(DEFAULT_MAX_SYMBOLS).describe("Maximum symbols to return."),
	}),
	outputSchema: z.object({
		server: z.string(),
		scope: z.enum(["document", "workspace"]),
		symbols: z.array(SymbolOutputSchema),
		total: z.number().int(),
		truncated: z.boolean(),
	}),
	async run(runtime, input, context) {
		const file = runtime.file(input, context);
		const workspace = input.scope === "workspace";
		const query = input.query;
		if (workspace && query === undefined)
			throw new ToolFailure("invalid_input", "'query' is required for workspace scope");
		return runtime.withSemantic(
			file,
			{
				server: input.server,
				signal: context.signal,
				readOnly: true,
				capability: workspace ? "workspaceSymbolProvider" : "documentSymbolProvider",
				method: workspace ? "workspace/symbol" : "textDocument/documentSymbol",
			},
			async (session) => {
				let all: SymbolOutput[];
				if (workspace) {
					const result = await session.client.request<Array<SymbolInformation | WorkspaceSymbol> | null>(
						"workspace/symbol",
						{ query },
						context.signal,
					);
					all = (result ?? []).map((symbol) => fromSymbolInformation(symbol, session));
				} else {
					const result = await session.client.request<Array<DocumentSymbol | SymbolInformation> | null>(
						"textDocument/documentSymbol",
						{ textDocument: { uri: file.uri } },
						context.signal,
					);
					const symbols = result ?? [];
					const outline = symbols.filter(isDocumentSymbol);
					all =
						outline.length === symbols.length
							? flattenDocumentSymbols(outline, file.path, session)
							: symbols
									.filter((symbol): symbol is SymbolInformation => !isDocumentSymbol(symbol))
									.map((symbol) => fromSymbolInformation(symbol, session));
				}
				const symbols = all.slice(0, input.limit);
				const truncated = all.length > symbols.length;
				const summary =
					all.length === 0
						? "No symbols found"
						: [
								...(truncated ? [`Found ${all.length} symbols (showing first ${symbols.length}):`] : []),
								...symbols.map(formatSymbol),
							].join("\n");
				return {
					summary,
					data: {
						server: session.client.target.server.id,
						scope: input.scope,
						symbols,
						total: all.length,
						truncated,
					},
				};
			},
		);
	},
});
