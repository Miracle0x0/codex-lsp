import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { builtHash, sourceHash } from "../../scripts/source-hash.mjs";
import { REPO_ROOT } from "./repo.js";

/**
 * Vitest global setup for suites that run dist/cli.js: rebuild unless dist was built from exactly the current
 * sources, so a CLI test never exercises an older implementation. A CI job that just built reuses that build.
 */
export function setup(): void {
	if (builtHash(REPO_ROOT) === sourceHash(REPO_ROOT)) return;
	const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "build.mjs")], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
	if (result.status !== 0) throw new Error(`build failed (status ${result.status ?? result.signal})`);
}
