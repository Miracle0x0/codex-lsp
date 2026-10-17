import { afterEach, expect, it } from "vitest";
import { describeWithTools } from "../support/tools.js";
import { batchOf, createWorkspace, type Workspace } from "./helpers.js";

const workspaces: Workspace[] = [];

afterEach(async () => {
	for (const created of workspaces.splice(0)) await created.close();
});

const SOURCE =
	'#ifndef PROJECT_FLAG\n#error "PROJECT_FLAG missing"\n#endif\nint main() {\n\tint count = "text";\n\treturn count;\n}\n';

describeWithTools("C/C++", ["clangd"], () => {
	it("#given a compile database with project flags #when checking #then clangd analyzes the file with those flags", async () => {
		// given
		const w = createWorkspace();
		workspaces.push(w);
		w.write(
			"compile_commands.json",
			JSON.stringify([
				{
					directory: w.root,
					file: "main.cpp",
					arguments: ["c++", "-std=c++20", "-DPROJECT_FLAG=1", "-c", "main.cpp"],
				},
			]),
		);
		w.write("main.cpp", SOURCE);

		// when
		const batch = batchOf((await w.call("diagnostics", { filePath: "main.cpp", severity: "error" })).data);

		// then
		expect(batch.providers[0]).toMatchObject({ serverId: "clangd", status: "ok" });
		expect(batch.diagnostics.map((diagnostic) => diagnostic.range.start.line)).toEqual([5]);
		expect(batch.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).not.toContain(
			"PROJECT_FLAG missing",
		);
	});

	it("#given no compile database #when checking the same file #then the missing flag shows the database was what differed", async () => {
		// given
		const w = createWorkspace();
		workspaces.push(w);
		w.write("main.cpp", SOURCE);

		// when
		const batch = batchOf((await w.call("diagnostics", { filePath: "main.cpp", severity: "error" })).data);

		// then
		expect(batch.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("PROJECT_FLAG missing");
	});
});
