import { defineConfig } from "vitest/config";

// Real shells, file watching, signals, and process trees. Cases that do not apply to the platform are skipped by
// name; a shell that is not installed is skipped with the reason, or fails when CODEX_LSP_REQUIRE_TOOLS=1 (CI).
export default defineConfig({
	test: {
		include: ["test/platform/**/*.test.ts"],
		globalSetup: ["test/support/fresh-build.ts"],
		environment: "node",
		pool: "forks",
		testTimeout: 60_000,
	},
});
