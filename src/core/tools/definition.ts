import type * as z from "zod";

import type { ToolCallContext } from "../runtime/context.js";
import type { LspRuntime } from "../runtime/runtime.js";

export interface ToolAnnotationHints {
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

/** Successful execution. `partial` marks results that carry data but did not fully complete. */
export interface ToolSuccess<Output> {
	readonly summary: string;
	readonly data: Output;
	readonly partial?: boolean;
}

export interface LspToolDefinition<Input extends z.ZodObject, Output extends z.ZodObject> {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly annotations: ToolAnnotationHints;
	readonly inputSchema: Input;
	readonly outputSchema: Output;
	run(runtime: LspRuntime, input: z.output<Input>, context: ToolCallContext): Promise<ToolSuccess<z.output<Output>>>;
}

/** Type-erased tool used for registration lists. */
export interface RegisteredLspTool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly annotations: ToolAnnotationHints;
	readonly inputSchema: z.ZodObject;
	readonly outputSchema: z.ZodObject;
	run(runtime: LspRuntime, input: unknown, context: ToolCallContext): Promise<ToolSuccess<Record<string, unknown>>>;
}

export function defineLspTool<Input extends z.ZodObject, Output extends z.ZodObject>(
	definition: LspToolDefinition<Input, Output>,
): RegisteredLspTool {
	return {
		name: definition.name,
		title: definition.title,
		description: definition.description,
		annotations: definition.annotations,
		inputSchema: definition.inputSchema,
		outputSchema: definition.outputSchema,
		run: (runtime, input, context) => definition.run(runtime, definition.inputSchema.parse(input), context),
	};
}
