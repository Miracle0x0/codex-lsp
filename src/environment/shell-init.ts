import { readFileSync } from "node:fs";

import { snapshotVariableNames } from "@code-yeongyu/lsp-tools-mcp";

export const SHELLS = ["bash", "zsh", "pwsh"] as const;
export type ShellName = (typeof SHELLS)[number];

export function isShellName(value: string): value is ShellName {
	return (SHELLS as readonly string[]).includes(value);
}

/** How the integration runs this CLI: absolute node and script paths, never PATH lookups. */
export interface CliCommand {
	readonly node: string;
	readonly script: string;
}

const TEMPLATES: Readonly<Record<ShellName, string>> = {
	bash: "codex-lsp.bash",
	zsh: "codex-lsp.zsh",
	pwsh: "codex-lsp.ps1",
};

const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const pwshQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Variables (plus the working directory) whose change triggers a new snapshot at the next prompt. */
function watchedNames(): string[] {
	return snapshotVariableNames([]).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/** Fills a template from `shell/`; values are quoted for the target shell. */
export function shellInitScript(shell: ShellName, cli: CliCommand): string {
	const template = readFileSync(new URL(`../../shell/${TEMPLATES[shell]}`, import.meta.url), "utf8");
	const quote = shell === "pwsh" ? pwshQuote : posixQuote;
	const names = shell === "pwsh" ? watchedNames().map(pwshQuote).join(", ") : watchedNames().join(" ");
	return template
		.replaceAll("@NAMES@", names)
		.replaceAll("@NODE@", quote(cli.node))
		.replaceAll("@CLI@", quote(cli.script));
}
