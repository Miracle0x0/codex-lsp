import { afterEach, expect, it } from "vitest";
import { describeWithTools } from "../support/tools.js";
import {
	batchOf,
	callItemsOf,
	callsOf,
	createWorkspace,
	hoverOf,
	locationsOf,
	positionOf,
	type Workspace,
} from "./helpers.js";

const workspaces: Workspace[] = [];

function module(): Workspace {
	const created = createWorkspace();
	workspaces.push(created);
	created.write("go.mod", "module example.com/demo\n\ngo 1.22\n");
	return created;
}

afterEach(async () => {
	for (const created of workspaces.splice(0)) await created.close();
});

describeWithTools("Go", ["go", "gopls"], () => {
	it("#given a module with a type error #when checking #then gopls reports it and status shows the Go toolchain", async () => {
		// given
		const w = module();
		w.write("main.go", 'package main\n\nfunc main() {\n\tvar count int = "text"\n\t_ = count\n}\n');

		// when
		const batch = batchOf((await w.call("diagnostics", { filePath: "main.go", severity: "error" })).data);
		const status = await w.call("status", { filePath: "main.go" });

		// then
		expect(batch.providers[0]).toMatchObject({ serverId: "gopls", status: "ok" });
		expect(batch.counts.error).toBeGreaterThanOrEqual(1);
		expect(batch.diagnostics[0]?.range.start.line).toBe(4);
		const toolchain = (status.data["file"] as { toolchain: { status: string; facts: Record<string, string | null> } })
			.toolchain;
		expect(toolchain.status).toBe("resolved");
		expect(toolchain.facts["GOVERSION"]).toMatch(/^go\d/);
		expect(toolchain.facts["GOMOD"]).toBe(`${w.root}/go.mod`);
	});

	it("#given an interface and an implementing type in another file #when asking implementations #then gopls finds the type", async () => {
		// given
		const w = module();
		const shape = "package main\n\ntype Shape interface {\n\tArea() int\n}\n";
		w.write("shape.go", shape);
		const square =
			"package main\n\ntype Square struct{}\n\nfunc (Square) Area() int { return 1 }\n\nfunc main() {}\n";
		const squarePath = w.write("square.go", square);

		// when
		const locations = locationsOf(
			(await w.call("goto_implementation", { filePath: "shape.go", ...positionOf(shape, "Shape") })).data,
		);

		// then
		const name = positionOf(square, "Square");
		expect(locations).toEqual([{ path: squarePath, range: { start: name, end: { ...name, character: 11 } } }]);
	});

	it("#given calls across files and a non-ASCII line #when walking calls and hovering #then positions map in code points", async () => {
		// given
		const w = module();
		const leaf = 'package main\n\nvar label = "😀😀"; func leaf() int { return len(label) }\n';
		const leafPath = w.write("leaf.go", leaf);
		const main =
			"package main\n\nfunc middle() int {\n\treturn leaf() + leaf()\n}\n\nfunc main() {\n\t_ = middle()\n}\n";
		w.write("main.go", main);

		// when
		const hover = hoverOf((await w.call("hover", { filePath: "leaf.go", ...positionOf(leaf, "leaf") })).data);
		const [middle] = callItemsOf(
			(await w.call("prepare_call_hierarchy", { filePath: "main.go", ...positionOf(main, "middle") })).data,
		);
		if (middle === undefined) throw new Error("no call hierarchy item for middle");
		const outgoing = callsOf((await w.call("outgoing_calls", { item: middle.handle })).data);
		const incoming = callsOf((await w.call("incoming_calls", { item: middle.handle })).data);

		// then
		expect(hover?.contents).toContain("func leaf() int");
		expect(outgoing.map((call) => [call.item.name, call.item.path, call.item.range.start])).toEqual([
			["leaf", leafPath, positionOf(leaf, "leaf")],
		]);
		expect(outgoing[0]?.fromRanges).toHaveLength(2);
		expect(incoming.map((call) => call.item.name)).toEqual(["main"]);
	});
});
