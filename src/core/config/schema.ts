import * as z from "zod";

import { SeveritySchema } from "../tools/schemas.js";

export const TOOLCHAIN_KINDS = ["python", "node", "rust", "go", "java", "cpp"] as const;
export type ToolchainKind = (typeof TOOLCHAIN_KINDS)[number];

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "ids use lowercase letters, digits, '.', '_' or '-'");
const ExtensionSchema = z.string().regex(/^\.[^./\\\s]+$/, "extensions look like '.ts'");
const VariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable names only");
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ServerConfigSchema = z.strictObject({
	command: z
		.array(z.string().min(1))
		.min(1)
		.describe("Executable and arguments; relative paths resolve against the workspace root."),
	env: z.record(VariableNameSchema, z.string()).optional(),
	settings: JsonObjectSchema.optional().describe("Served through workspace/configuration and didChangeConfiguration."),
	initializationOptions: JsonObjectSchema.optional(),
	rootMarkers: z.array(z.string().min(1)).optional().describe("Files or directories that mark a project root."),
	installHint: z.string().min(1).optional(),
});

export const DisabledServerSchema = z.strictObject({ disabled: z.literal(true) });

export const LanguageConfigSchema = z.strictObject({
	extensions: z.array(ExtensionSchema).min(1).optional(),
	languageId: z.string().min(1).optional(),
	toolchain: z.enum(TOOLCHAIN_KINDS).nullable().optional(),
	semanticServer: IdSchema.nullable().optional(),
	diagnosticServers: z.array(IdSchema).optional(),
	disabled: z.literal(true).optional(),
});

export const EnvironmentConfigSchema = z.strictObject({
	source: z
		.enum(["active-shell", "process"])
		.optional()
		.describe("active-shell uses the bound shell snapshot; process uses the MCP server's own environment."),
	python: z
		.strictObject({
			interpreter: z.string().min(1).describe("Fixed interpreter; overrides the shell's active Python."),
		})
		.optional(),
	extraVariables: z.array(VariableNameSchema).optional(),
});

export const DiagnosticsConfigSchema = z.strictObject({
	exclude: z
		.array(z.string().min(1))
		.optional()
		.describe("Directory names or workspace-relative path prefixes skipped by directory diagnostics."),
	minimumSeverity: SeveritySchema.optional(),
});

export const ConfigFileSchema = z.strictObject({
	$schema: z.string().optional(),
	schemaVersion: z.literal(1),
	environment: EnvironmentConfigSchema.optional(),
	diagnostics: DiagnosticsConfigSchema.optional(),
	servers: z.record(IdSchema, z.union([ServerConfigSchema, DisabledServerSchema])).optional(),
	languages: z.record(IdSchema, LanguageConfigSchema).optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type LanguageConfig = z.infer<typeof LanguageConfigSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;
