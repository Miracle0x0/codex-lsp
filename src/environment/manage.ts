import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { manifestPath, readManifest, readSnapshot } from "@code-yeongyu/lsp-tools-mcp";

/** Lists metadata only; captured environment variable values stay on disk. */
export function listEnvironments(stateDir: string) {
	const directory = join(stateDir, "environments");
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const manifest = readManifest(stateDir, entry.name);
			if (manifest === undefined) throw new Error(`Environment ${entry.name} has no manifest`);
			const snapshot = readSnapshot(stateDir, manifest);
			return {
				environmentId: manifest.environmentId,
				kind: manifest.kind,
				generation: manifest.generation,
				capturedAt: snapshot.capturedAt,
				cwd: snapshot.cwd,
			};
		})
		.sort((a, b) => a.environmentId.localeCompare(b.environmentId));
}

/** Deletion is an explicit CLI operation; never infer that an externally pinned environment is unused. */
export function removeEnvironment(stateDir: string, id: string): void {
	const manifest = readManifest(stateDir, id);
	if (manifest === undefined) throw new Error(`Environment ${id} has no captured snapshot`);
	rmSync(dirname(manifestPath(stateDir, id)), { recursive: true });
}
