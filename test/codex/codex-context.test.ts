import { describe, expect, it } from "vitest";

import { CODEX_TURN_METADATA_KEY, resolveCodexContext } from "../../src/codex/context.js";

describe("Codex call context", () => {
	it("#given Codex turn metadata with one workspace #when resolving #then workspace and session ids are used", () => {
		// given
		const meta = {
			[CODEX_TURN_METADATA_KEY]: {
				session_id: "sess-1",
				turn_id: "turn-1",
				workspaces: { "/repo": { has_changes: false } },
			},
		};

		// when
		const context = resolveCodexContext(meta);

		// then
		expect(context).toEqual({ workspaceRoot: "/repo", sessionId: "sess-1", turnId: "turn-1" });
	});

	it("#given several workspaces #when resolving #then no default workspace is guessed", () => {
		// given
		const meta = { [CODEX_TURN_METADATA_KEY]: { session_id: "sess-1", workspaces: { "/a": {}, "/b": {} } } };

		// when
		const context = resolveCodexContext(meta);

		// then
		expect(context).toEqual({ sessionId: "sess-1" });
	});

	it("#given malformed or missing metadata #when resolving #then the context is empty", () => {
		expect(resolveCodexContext(undefined)).toEqual({});
		expect(resolveCodexContext({ [CODEX_TURN_METADATA_KEY]: { session_id: 42 } })).toEqual({});
		expect(resolveCodexContext({ [CODEX_TURN_METADATA_KEY]: { workspaces: { "relative/dir": {} } } })).toEqual({});
	});
});
