// Identity of the inputs `scripts/build.mjs` compiles. The build records it in dist/build-info.json so tests
// and packaging can tell a build of the current sources from a stale one, instead of trusting that dist exists.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? files(path) : [path];
	});
}

export const BUILD_INFO = join("dist", "build-info.json");

export function sourceHash(root) {
	const hash = createHash("sha256");
	const inputs = [...files(join(root, "src")), join(root, "tsconfig.json"), join(root, "tsconfig.build.json")];
	for (const path of inputs.map((input) => relative(root, input).replaceAll("\\", "/")).sort()) {
		hash.update(`${path}\0`).update(readFileSync(join(root, path))).update("\0");
	}
	const compiler = JSON.parse(readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf8"));
	return hash.update(`typescript@${compiler.version}`).digest("hex");
}

/** The source hash a build recorded, or undefined when there is no build. */
export function builtHash(distParent) {
	try {
		return JSON.parse(readFileSync(join(distParent, BUILD_INFO), "utf8")).sourceHash;
	} catch {
		return undefined;
	}
}
