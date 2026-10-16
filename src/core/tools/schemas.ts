import * as z from "zod";

import { EnvironmentIdSchema } from "../environment/snapshot.js";

/** Public positions: 1-based line, 0-based column counted in Unicode code points. */
export const PositionSchema = z.object({
	line: z.number().int().min(1).describe("1-based line number."),
	character: z.number().int().min(0).describe("0-based column, counted in Unicode code points."),
});

export const RangeSchema = z.object({
	start: PositionSchema,
	end: PositionSchema,
});

export const LocationSchema = z.object({
	path: z.string().describe("Absolute file path."),
	range: RangeSchema,
});

export const WorkspaceInputShape = {
	workspaceRoot: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Absolute workspace root used to resolve relative paths and project config. Defaults to the host workspace.",
		),
	environmentId: EnvironmentIdSchema.optional().describe(
		"Captured shell environment to analyze with. Defaults to the environment bound to this session.",
	),
};

export const FileInputShape = {
	filePath: z.string().min(1).describe("Source file path, absolute or relative to the workspace root."),
	...WorkspaceInputShape,
};

export const ServerInputShape = {
	server: z
		.string()
		.min(1)
		.optional()
		.describe("Server id to ask instead of the language's configured semantic server."),
};

export const PositionInputShape = {
	...FileInputShape,
	line: PositionSchema.shape.line,
	character: PositionSchema.shape.character,
	...ServerInputShape,
};

export const SeveritySchema = z.enum(["error", "warning", "information", "hint"]);

export type PublicLocation = z.infer<typeof LocationSchema>;
