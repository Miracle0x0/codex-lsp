import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/core/**/*.test.ts", "test/codex/**/*.test.ts"],
		environment: "node",
		pool: "threads",
	},
});
