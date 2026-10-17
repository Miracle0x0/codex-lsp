import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, independent of the directory tests are started from. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function repoPath(...parts: string[]): string {
	return join(REPO_ROOT, ...parts);
}

/** The built CLI; the default and platform suites build it from the current sources first (see fresh-build.ts). */
export const CLI_PATH = repoPath("dist", "cli.js");
