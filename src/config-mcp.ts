import { readFileSync } from "node:fs";

import * as z from "zod";

import { CONTEXT_ID_ENV, MANIFEST_ENV } from "./environment/binding.js";
import type { CliCommand } from "./environment/shell-init.js";

const HooksFileSchema = z.object({
	hooks: z.record(
		z.string(),
		z.array(
			z.object({
				matcher: z.string(),
				hooks: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.record(z.string(), z.string())]))),
			}),
		),
	),
});

const toml = (value: string | number): string => (typeof value === "number" ? String(value) : JSON.stringify(value));

export interface McpConfigOptions {
	readonly cli: CliCommand;
	/** The plugin's hooks/hooks.json; the generated hooks mirror it. */
	readonly hooksPath: string;
	/** Pins the MCP server to one captured environment (for example a shell's id) instead of forwarding the launcher's. */
	readonly pinned?: { readonly environmentId: string; readonly manifestPath: string };
}

/**
 * Codex config.toml text that wires codex-lsp without the plugin system. It is printed for review;
 * nothing writes it into a user's config.
 */
export function mcpConfigToml(options: McpConfigOptions): string {
	const hooks = HooksFileSchema.parse(JSON.parse(readFileSync(options.hooksPath, "utf8"))).hooks;
	const lines = [
		"# codex-lsp for ~/.codex/config.toml. Review before adding; this command changed nothing.",
		"[features]",
		"mcp_2026_07_28 = true",
		"",
		"[mcp_servers.lsp]",
		`command = ${toml(options.cli.node)}`,
		`args = [${toml(options.cli.script)}, "mcp"]`,
		...(options.pinned === undefined ? [`env_vars = [${toml(CONTEXT_ID_ENV)}, ${toml(MANIFEST_ENV)}]`] : []),
		"",
		"[mcp_servers.lsp.env]",
		'CODEX_MCP_PROTOCOL_VERSION = "2026-07-28"',
		...(options.pinned === undefined
			? []
			: [
					`${CONTEXT_ID_ENV} = ${toml(options.pinned.environmentId)}`,
					`${MANIFEST_ENV} = ${toml(options.pinned.manifestPath)}`,
				]),
	];
	for (const [event, groups] of Object.entries(hooks)) {
		for (const group of groups) {
			lines.push("", `[[hooks.${event}]]`, `matcher = ${toml(group.matcher)}`);
			for (const handler of group.hooks) {
				lines.push("", `[[hooks.${event}.hooks]]`);
				const tables: Array<[string, Record<string, string>]> = [];
				for (const [key, value] of Object.entries(handler)) {
					if (typeof value === "object") tables.push([key, value]);
					else lines.push(`${key} = ${toml(value)}`);
				}
				for (const [key, table] of tables) {
					lines.push("", `[hooks.${event}.hooks.${key}]`);
					for (const [field, value] of Object.entries(table)) lines.push(`${field} = ${toml(value)}`);
				}
			}
		}
	}
	return `${lines.join("\n")}\n`;
}
