import { incomingCallsTool, outgoingCallsTool, prepareCallHierarchyTool } from "./call-hierarchy.js";
import type { RegisteredLspTool } from "./definition.js";
import { diagnosticsTool } from "./diagnostics.js";
import {
	findReferencesTool,
	gotoDefinitionTool,
	gotoImplementationTool,
	hoverTool,
	symbolsTool,
} from "./navigation.js";
import { prepareRenameTool, renameTool } from "./rename.js";
import { statusTool } from "./status.js";

export const LSP_TOOLS: readonly RegisteredLspTool[] = [
	statusTool,
	diagnosticsTool,
	gotoDefinitionTool,
	gotoImplementationTool,
	findReferencesTool,
	hoverTool,
	symbolsTool,
	prepareCallHierarchyTool,
	incomingCallsTool,
	outgoingCallsTool,
	prepareRenameTool,
	renameTool,
];
