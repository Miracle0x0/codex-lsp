import { isAbsolute } from "node:path";
import * as z from "zod";
import type { ContextResolver, HostCallContext } from "../core/index.js";

/**
 * Codex attaches turn metadata to every MCP tools/call request under this key.
 * Observed on Codex CLI 0.163.0; hook-initiated calls carry only `threadId`.
 */
export const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata";

const TurnMetadataSchema = z.object({
	session_id: z.string().min(1).optional(),
	turn_id: z.string().min(1).optional(),
	workspaces: z.record(z.string(), z.unknown()).optional(),
});

function singleWorkspace(workspaces: Record<string, unknown> | undefined): string | undefined {
	if (workspaces === undefined) return undefined;
	const roots = Object.keys(workspaces).filter((root) => isAbsolute(root));
	// Several workspaces make the default ambiguous; tools then need an absolute path or workspaceRoot.
	return roots.length === 1 ? roots[0] : undefined;
}

export const resolveCodexContext: ContextResolver = (meta) => {
	const parsed = TurnMetadataSchema.safeParse(meta?.[CODEX_TURN_METADATA_KEY]);
	if (!parsed.success) return {};
	const workspaceRoot = singleWorkspace(parsed.data.workspaces);
	const context: HostCallContext = {
		...(workspaceRoot === undefined ? {} : { workspaceRoot }),
		...(parsed.data.session_id === undefined ? {} : { sessionId: parsed.data.session_id }),
		...(parsed.data.turn_id === undefined ? {} : { turnId: parsed.data.turn_id }),
	};
	return context;
};
