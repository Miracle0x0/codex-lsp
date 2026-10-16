import { readFileSync } from "node:fs";

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

/** Fills a template from `shell/`; values are quoted for the target shell. */
export function shellInitScript(shell: ShellName, cli: CliCommand): string {
	const template = readFileSync(new URL(`../../../shell/${TEMPLATES[shell]}`, import.meta.url), "utf8");
	const quote = shell === "pwsh" ? pwshQuote : posixQuote;
	return template.replaceAll("@NODE@", quote(cli.node)).replaceAll("@CLI@", quote(cli.script));
}
