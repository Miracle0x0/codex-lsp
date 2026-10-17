import { describe, it } from "vitest";

import { findExecutable } from "../../src/core/lsp/command.js";

/**
 * Whether missing tools fail a suite instead of skipping it. CI installs every tool and sets this; on a
 * developer machine a suite whose tools are absent is skipped, with the reason in its title.
 */
export const TOOLS_REQUIRED = process.env["CODEX_LSP_REQUIRE_TOOLS"] === "1";

/** A precondition other than a program on PATH, for example an authentication file. */
export interface Precondition {
	readonly name: string;
	readonly met: boolean;
}

/** The named programs absent from PATH, plus unmet preconditions. */
export function missingTools(programs: readonly string[], preconditions: readonly Precondition[] = []): string[] {
	return [
		...programs.filter((program) => findExecutable(program, process.env) === undefined),
		...preconditions.filter((precondition) => !precondition.met).map((precondition) => precondition.name),
	];
}

/**
 * `describe` for a suite that needs external tools. With all of them present it runs normally; otherwise it
 * is skipped and says why, or, when tools are required (CI), it fails with the missing names.
 */
export function describeWithTools(
	title: string,
	programs: readonly string[],
	body: () => void,
	preconditions: readonly Precondition[] = [],
): void {
	const missing = missingTools(programs, preconditions);
	if (missing.length === 0) {
		describe(title, body);
	} else if (TOOLS_REQUIRED) {
		describe(title, () => {
			it("has its required tools", () => {
				throw new Error(`missing required tools: ${missing.join(", ")}`);
			});
		});
	} else {
		const reason = `${missing.join(", ")} not available`;
		process.stderr.write(`skipping "${title}": ${reason} (CODEX_LSP_REQUIRE_TOOLS=1 makes this a failure)\n`);
		describe.skip(`${title} [skipped: ${reason}]`, body);
	}
}
