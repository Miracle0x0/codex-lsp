import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	batchOf,
	callItemsOf,
	callsOf,
	createWorkspace,
	hoverOf,
	linkTypeScript,
	locationsOf,
	PACKAGE_ROOT,
	positionOf,
	type Workspace,
} from "./helpers.js";

const compiler = join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc");
const workspaces: Workspace[] = [];

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
});

function workspace(): Workspace {
	const created = createWorkspace({
		schemaVersion: 1,
		servers: {
			typescript7: {
				command: [process.execPath, compiler, "--lsp", "--stdio"],
				rootMarkers: ["tsconfig.json", "package.json"],
			},
		},
		languages: { typescript: { semanticServer: "typescript7", diagnosticServers: ["typescript7"] } },
	});
	workspaces.push(created);
	linkTypeScript(created.root, 7);
	created.write("package.json", '{ "name": "ts7-fixture", "type": "module" }\n');
	created.write(
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				strict: true,
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				noEmit: true,
			},
		}),
	);
	return created;
}

describe("TypeScript 7 native language server", () => {
	it("#given a type error #when checking and editing #then the actual v7 server reports and clears it", async () => {
		const w = workspace();
		w.write("main.ts", 'export const count: number = "wrong";\n');
		const before = batchOf((await w.call("diagnostics", { filePath: "main.ts", severity: "error" })).data);
		expect(before.complete).toBe(true);
		expect(before.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ providerId: "typescript7", code: 2322 })]),
		);
		const client = w.runtime.manager.activeClients()[0];
		expect(client?.target.args).toEqual([compiler, "--lsp", "--stdio"]);
		expect(client?.serverInfo?.version).toMatch(/^7\./);
		w.write("main.ts", "export const count: number = 1;\n");
		const after = batchOf((await w.call("diagnostics", { filePath: "main.ts" })).data);
		expect(after.complete).toBe(true);
		expect(after.counts.error).toBe(0);
		const status = await w.call("status", { filePath: "main.ts" });
		expect(status.data).toMatchObject({ file: { toolchain: { facts: { typescriptVersion: "7.0.2" } } } });
	});

	it("#given a cross-file symbol #when navigating and renaming #then v7 resolves and updates both files", async () => {
		const w = workspace();
		const library = 'export function greet(name: string): string { return "hi " + name; }\n';
		const main = 'import { greet } from "./lib.js";\nexport const message = greet("world");\n';
		const libPath = w.write("lib.ts", library);
		const mainPath = w.write("main.ts", main);
		const position = { filePath: "lib.ts", ...positionOf(library, "greet") };
		const definition = locationsOf(
			(await w.call("goto_definition", { filePath: "main.ts", ...positionOf(main, "greet", 1) })).data,
		);
		expect(definition.map((item) => item.path)).toContain(libPath);
		const references = await w.call("find_references", position);
		expect(references.data).toMatchObject({
			references: expect.arrayContaining([expect.objectContaining({ path: mainPath })]),
		});
		expect(hoverOf((await w.call("hover", position)).data)?.contents).toContain("string");
		expect((await w.call("prepare_rename", position)).data["canRename"]).toBe(true);
		const rename = await w.call("rename", { ...position, newName: "salute" });
		expect(rename.data["applied"]).toBe(true);
		expect(readFileSync(libPath, "utf8")).toContain("function salute");
		expect(readFileSync(mainPath, "utf8")).toContain('salute("world")');
		expect(batchOf((await w.call("diagnostics", { filePath: "." })).data).counts.error).toBe(0);
	});

	it("#given two functions #when following call hierarchy #then v7 returns callers and callees", async () => {
		const w = workspace();
		const source =
			"export function leaf(): number { return 1; }\nexport function root(): number { return leaf(); }\nroot();\n";
		w.write("main.ts", source);
		const [root] = callItemsOf(
			(await w.call("prepare_call_hierarchy", { filePath: "main.ts", ...positionOf(source, "root") })).data,
		);
		if (root === undefined) throw new Error("TypeScript 7 returned no root call item");
		const outgoing = callsOf((await w.call("outgoing_calls", { item: root.handle })).data);
		const leaf = outgoing.find((call) => call.item.name === "leaf")?.item;
		if (leaf === undefined) throw new Error("TypeScript 7 returned no leaf callee");
		const incoming = callsOf((await w.call("incoming_calls", { item: leaf.handle })).data);
		expect(incoming.map((call) => call.item.name)).toContain("root");
	});

	it("#given the same project #when invoking the v7 compiler #then real type checking fails and recovers", () => {
		const w = workspace();
		w.write("main.ts", 'export const count: number = "wrong";\n');
		const compile = () =>
			spawnSync(process.execPath, [compiler, "--noEmit", "--pretty", "false", "-p", "tsconfig.json"], {
				cwd: w.root,
				encoding: "utf8",
			});
		const before = compile();
		expect(before.status).not.toBe(0);
		expect(before.stdout).toContain("TS2322");
		w.write("main.ts", "export const count: number = 1;\n");
		expect(compile().status).toBe(0);
	});
});
