import { defineConfig } from "vitest/config";

// Default suite: logic and component tests. They need Node and the locked dev dependencies only; CLI tests run
// a dist/ built from the current sources (fresh-build rebuilds when it is missing or stale).
export default defineConfig({
	test: {
		include: ["test/core/**/*.test.ts", "test/codex/**/*.test.ts"],
		globalSetup: ["test/support/fresh-build.ts"],
		environment: "node",
		pool: "threads",
	},
});
