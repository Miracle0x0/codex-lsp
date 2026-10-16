/** A Codex hook placeholder such as `${tool_input}`, spelled without a template-literal lookalike. */
export function placeholder(field: string): string {
	return ["$", "{", field, "}"].join("");
}
