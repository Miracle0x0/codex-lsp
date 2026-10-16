import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { batchOf, createWorkspace, hoverOf, positionOf, requireTool, type Workspace } from "./helpers.js";

const workspaces: Workspace[] = [];

afterEach(async () => {
	for (const created of workspaces.splice(0)) await created.close();
});

beforeAll(() => {
	requireTool("cargo");
	requireTool("rustc");
	requireTool("rust-analyzer");
});

function crate(main: string): Workspace {
	const created = createWorkspace();
	workspaces.push(created);
	created.write("Cargo.toml", '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
	created.write("src/main.rs", main);
	return created;
}

interface Toolchain {
	readonly status: string;
	readonly source: string;
	readonly summary?: string;
	readonly facts: Record<string, string | null>;
}

const toolchainOf = (data: Record<string, unknown>): Toolchain => (data["file"] as { toolchain: Toolchain }).toolchain;

describe("Rust", () => {
	it("#given a crate with a type mismatch #when checking #then rust-analyzer reports it and hover resolves types", async () => {
		// given
		const source =
			'fn label() -> i32 {\n\t"text"\n}\n\nfn main() {\n\tlet value = label();\n\tprintln!("{value}");\n}\n';
		const w = crate(source);

		// when
		const batch = batchOf((await w.call("diagnostics", { filePath: "src/main.rs", severity: "error" })).data);
		const hover = hoverOf((await w.call("hover", { filePath: "src/main.rs", ...positionOf(source, "value") })).data);

		// then
		expect(batch.providers[0]).toMatchObject({ serverId: "rust", status: "ok" });
		expect(batch.diagnostics.map((diagnostic) => diagnostic.range.start.line)).toContain(2);
		expect(hover?.contents).toContain("i32");
	});

	it("#given a borrow error only cargo check finds #when checking first and after edits #then it is reported and cleared", async () => {
		// given
		const broken =
			'fn main() {\n\tlet r;\n\t{\n\t\tlet s = String::new();\n\t\tr = &s;\n\t}\n\tprintln!("{r}");\n}\n';
		const w = crate(broken);

		// when
		const first = batchOf((await w.call("diagnostics", { filePath: "src/main.rs", severity: "error" })).data);
		w.write("src/main.rs", 'fn main() {\n\tlet s = String::new();\n\tprintln!("{s}");\n}\n');
		const fixed = batchOf((await w.call("diagnostics", { filePath: "src/main.rs", severity: "error" })).data);
		w.write("src/main.rs", broken);
		const again = batchOf((await w.call("diagnostics", { filePath: "src/main.rs", severity: "error" })).data);

		// then
		const codes = (batch: typeof first) => [
			...new Set(batch.diagnostics.map((diagnostic) => String(diagnostic.code))),
		];
		expect(codes(first)).toContain("E0597");
		expect(first.complete).toBe(true);
		expect(fixed.counts.error).toBe(0);
		expect(codes(again)).toContain("E0597");
	});

	it("#given the active toolchain #when asking status for a file #then rustc, its version, and the sysroot are reported", async () => {
		// given
		const w = crate("fn main() {}\n");

		// when
		const toolchain = toolchainOf((await w.call("status", { filePath: "src/main.rs" })).data);

		// then
		expect(toolchain.status).toBe("resolved");
		expect(toolchain.facts["rustcVersion"]).toMatch(/^rustc \d+\.\d+/);
		expect(toolchain.facts["sysroot"]).toBeTruthy();
	});

	const rustupToolchains = join(process.env["RUSTUP_HOME"] ?? join(homedir(), ".rustup"), "toolchains");
	it.runIf(existsSync(rustupToolchains))(
		"#given rust-toolchain.toml naming a toolchain that is not installed #when resolving #then it fails without installing it",
		async () => {
			// given
			const w = crate("fn main() {}\n");
			w.write("rust-toolchain.toml", '[toolchain]\nchannel = "1.40.0"\n');
			const before = readdirSync(rustupToolchains).sort();

			// when
			const toolchain = toolchainOf((await w.call("status", { filePath: "src/main.rs" })).data);

			// then
			expect(toolchain.status).toBe("unavailable");
			expect(toolchain.facts["toolchainFile"]).toBe(join(w.root, "rust-toolchain.toml"));
			expect(readdirSync(rustupToolchains).sort()).toEqual(before);
		},
	);
});
