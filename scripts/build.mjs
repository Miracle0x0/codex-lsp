import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(join(root, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`TypeScript build terminated by ${result.signal}`);
process.exitCode = result.status;
