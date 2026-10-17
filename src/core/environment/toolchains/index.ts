import type { ToolchainKind } from "../../config/schema.js";
import { resolveCpp } from "./cpp.js";
import { resolveGo } from "./go.js";
import { resolveJava } from "./java.js";
import { resolveNode } from "./node.js";
import { resolvePython } from "./python.js";
import { resolveRust } from "./rust.js";
import type { ToolchainAdapter } from "./types.js";

export const TOOLCHAIN_ADAPTERS: Readonly<Record<ToolchainKind, ToolchainAdapter>> = {
	python: resolvePython,
	node: resolveNode,
	rust: resolveRust,
	go: resolveGo,
	java: resolveJava,
	cpp: resolveCpp,
};

export type {
	ToolchainAdapter,
	ToolchainInput,
	ToolchainInputFile,
	ToolchainResolution,
	TypeScriptBackend,
	TypeScriptSdk,
} from "./types.js";
