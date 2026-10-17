import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_INFO, sourceHash } from "./source-hash.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(join(root, "dist"), { recursive: true, force: true });
const inputs = sourceHash(root);
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`TypeScript build terminated by ${result.signal}`);
// Records which sources this build compiled; tests and packaging reuse dist only when it matches.
if (result.status === 0) writeFileSync(join(root, BUILD_INFO), `${JSON.stringify({ sourceHash: inputs })}\n`);
process.exitCode = result.status;
