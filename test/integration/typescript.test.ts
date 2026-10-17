import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { describeWithTools } from "../support/tools.js";
import {
	batchOf,
	callItemsOf,
	callsOf,
	createWorkspace,
	hoverOf,
	linkTypeScript,
	locationsOf,
	positionOf,
	type Workspace,
} from "./helpers.js";

const workspaces: Workspace[] = [];

function workspace(): Workspace {
	const created = createWorkspace();
	workspaces.push(created);
	linkTypeScript(created.root);
	created.write("package.json", '{ "name": "demo", "private": true, "type": "module" }\n');
	created.write(
		"tsconfig.json",
		'{ "compilerOptions": { "strict": true, "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext" } }\n',
	);
	return created;
}

afterEach(async () => {
	for (const created of workspaces.splice(0)) await created.close();
});

describeWithTools("TypeScript", ["typescript-language-server"], () => {
	it("#given a cross-file symbol #when renaming #then the caller is updated and no stale 'not exported' error remains", async () => {
		// given
		const w = workspace();
		w.write("src/lib.ts", 'export function greet(name: string): string {\n\treturn "hi " + name;\n}\n');
		w.write("src/main.ts", 'import { greet } from "./lib.js";\n\nconsole.log(greet("x"));\n');
		const before = await w.call("diagnostics", { filePath: "src/main.ts" });
		expect(batchOf(before.data).counts.error).toBe(0);

		// when
		const rename = await w.call("rename", { filePath: "src/lib.ts", line: 1, character: 16, newName: "salute" });
		const after = batchOf((await w.call("diagnostics", { filePath: "src/main.ts" })).data);

		// then
		expect(rename.partial).toBe(false);
		expect(readFileSync(join(w.root, "src", "main.ts"), "utf8")).toContain("salute");
		expect(readFileSync(join(w.root, "src", "lib.ts"), "utf8")).toContain("function salute");
		const renameDiagnostics = batchOf(rename.data["diagnostics"]);
		expect(renameDiagnostics.counts.error).toBe(0);
		expect(after.counts.error).toBe(0);
		expect(after.complete).toBe(true);
		const [client] = w.runtime.manager.activeClients();
		expect(client?.target.launch.backend).toBe("typescript-language-server");
		expect(client?.target.initializationOptions).toEqual({
			tsserver: { useSyntaxServer: "never", path: join(w.root, "node_modules", "typescript", "lib", "tsserver.js") },
		});
	});

	it("#given sub-projects on TypeScript 6 and 7 #when checking the whole workspace #then each is checked by its own SDK", async () => {
		// given
		const w = createWorkspace();
		workspaces.push(w);
		for (const [name, version] of [
			["old", 6],
			["new", 7],
		] as const) {
			w.write(`packages/${name}/package.json`, `{ "name": "${name}", "type": "module" }\n`);
			w.write(
				`packages/${name}/tsconfig.json`,
				'{ "compilerOptions": { "strict": true, "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "noEmit": true } }\n',
			);
			linkTypeScript(join(w.root, "packages", name), version);
			w.write(`packages/${name}/src/main.ts`, `export const ${name}Value: number = "${name}";\n`);
		}

		// when
		const batch = batchOf((await w.call("diagnostics", { filePath: "packages", severity: "error" })).data);

		// then
		expect(batch.complete).toBe(true);
		expect(batch.diagnostics.map((item) => [item.path, item.code]).sort()).toEqual([
			[join(w.root, "packages", "new", "src", "main.ts"), 2322],
			[join(w.root, "packages", "old", "src", "main.ts"), 2322],
		]);
		const clients = w.runtime.manager
			.activeClients()
			.map((client) => [client.target.projectRoot, client.target.launch.backend, client.serverInfo?.version ?? ""]);
		expect(clients.sort()).toEqual([
			[join(w.root, "packages", "new"), "typescript-native", expect.stringMatching(/^7\./)],
			[join(w.root, "packages", "old"), "typescript-language-server", expect.any(String)],
		]);
	});

	it("#given more than fifty files #when checking the directory #then every file is checked", async () => {
		// given
		const w = workspace();
		for (let index = 0; index < 60; index += 1) {
			w.write(
				`src/m${index}.ts`,
				index === 37 ? "export const value: number = 'nope';\n" : `export const value${index} = ${index};\n`,
			);
		}

		// when
		const batch = batchOf((await w.call("diagnostics", { filePath: "src", severity: "error" })).data);

		// then
		expect(batch.coverage.checkedFiles).toBe(60);
		expect(batch.counts.error).toBe(1);
		expect(batch.diagnostics[0]).toMatchObject({
			path: join(w.root, "src", "m37.ts"),
			code: 2322,
			providerId: "typescript",
		});
	});

	it("#given a project TypeScript SDK #when asking status for a file #then the Node runtime and SDK are reported separately", async () => {
		// given
		const w = workspace();
		w.write("src/a.ts", "export {};\n");

		// when
		const status = await w.call("status", { filePath: "src/a.ts" });

		// then
		const toolchain = (status.data["file"] as { toolchain: { status: string; facts: Record<string, string> } })
			.toolchain;
		expect(toolchain.status).toBe("resolved");
		expect(toolchain.facts["typescriptSdk"]).toBe(join(w.root, "node_modules", "typescript"));
		expect(toolchain.facts["typescriptVersion"]).toMatch(/^\d+\.\d+/);
		expect(toolchain.facts["nodeVersion"]).toMatch(/^v\d+/);
		expect(toolchain.facts["typescriptBackend"]).toBe("typescript-language-server");
		expect(status.data["file"]).toMatchObject({
			servers: [
				{
					serverId: "typescript",
					backend: "typescript-language-server",
					reason: expect.stringContaining(join(w.root, "node_modules", "typescript", "lib", "tsserver.js")),
				},
			],
		});
	});

	it("#given a line with astral characters before a symbol #when hovering #then the code-point column finds it and maps back", async () => {
		// given
		const w = workspace();
		const source = 'const label = "😀😀"; export function leaf(): number {\n\treturn label.length;\n}\n';
		w.write("src/calls.ts", source);
		const at = positionOf(source, "leaf");

		// when
		const hover = hoverOf((await w.call("hover", { filePath: "src/calls.ts", ...at })).data);

		// then
		expect(hover?.contents).toContain("function leaf(): number");
		expect(hover?.range?.start).toEqual(at);
	});

	it("#given a cold server #when the first requests ask for implementations and references #then cross-file results are complete", async () => {
		// given
		const w = workspace();
		const shape = "export interface Shape {\n\tarea(): number;\n}\n";
		w.write("src/shape.ts", shape);
		const square =
			'import type { Shape } from "./shape.js";\n\nexport class Square implements Shape {\n\tarea(): number {\n\t\treturn 1;\n\t}\n}\n';
		const squarePath = w.write("src/square.ts", square);
		const at = { filePath: "src/shape.ts", ...positionOf(shape, "Shape") };

		// when
		const implementations = locationsOf((await w.call("goto_implementation", at)).data);
		const references = await w.call("find_references", at);

		// then
		const name = positionOf(square, "Square");
		expect(implementations).toEqual([{ path: squarePath, range: { start: name, end: { ...name, character: 19 } } }]);
		expect(references.data["total"]).toBe(3);
	});

	it("#given nested calls #when walking the call hierarchy #then incoming and outgoing calls follow the chain", async () => {
		// given
		const w = workspace();
		const source =
			"export function leaf(): number {\n\treturn 1;\n}\n\nexport function middle(): number {\n\treturn leaf() + leaf();\n}\n\nexport function top(): number {\n\treturn middle();\n}\n";
		const path = w.write("src/chain.ts", source);

		// when
		const [middle] = callItemsOf(
			(await w.call("prepare_call_hierarchy", { filePath: "src/chain.ts", ...positionOf(source, "middle") })).data,
		);
		if (middle === undefined) throw new Error("no call hierarchy item for middle");
		const incoming = callsOf((await w.call("incoming_calls", { item: middle.handle })).data);
		const outgoing = callsOf((await w.call("outgoing_calls", { item: middle.handle })).data);
		const top = incoming[0]?.item;
		if (top === undefined) throw new Error("no caller of middle");
		const fromTop = callsOf((await w.call("outgoing_calls", { item: top.handle })).data);

		// then
		expect(middle).toMatchObject({ name: "middle", kind: "Function", path });
		expect(incoming.map((call) => call.item.name)).toEqual(["top"]);
		expect(incoming[0]?.fromRanges.map((range) => range.start)).toEqual([positionOf(source, "middle", 1)]);
		expect(outgoing.map((call) => call.item.name)).toEqual(["leaf"]);
		expect(outgoing[0]?.fromRanges.map((range) => range.start)).toEqual([
			positionOf(source, "leaf", 1),
			positionOf(source, "leaf", 2),
		]);
		expect(fromTop.map((call) => call.item.name)).toEqual(["middle"]);
	});
});
