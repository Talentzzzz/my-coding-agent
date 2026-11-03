// Vendored from @earendil-works/pi-ai (0.99.2). Checked by packages/llm/tsconfig.json under pi's own compiler
// settings; @ts-nocheck keeps the repo root's stricter config from flagging this file,
// while every import into packages/core stays fully checked.
// @ts-nocheck
import type { Message, SystemMessage, Tool } from "../types.ts";

/**
 * Build the leading system message for a prompt. Returns undefined when the prompt is empty, so an
 * empty transcript stays empty.
 *
 * Named for what it makes, not for when: this runs before every request rather than once
 * per conversation, because the prompt is resent whole each time. Tools do not come through here —
 * they are a request parameter, carried by `LlmContext.tools`.
 */
export function createSystemMessage(systemPrompt: string | undefined): SystemMessage | undefined {
	if (systemPrompt === undefined || systemPrompt.length === 0) return undefined;
	return { role: "system", content: systemPrompt, timestamp: 0 };
}

/**
 * The leading system message, if the transcript starts with one — the fallback a transport reads
 * when the request carries no explicit `Context.system`.
 *
 * The leading message is the only place a system message can be: a later one is dropped
 * before it reaches a transport, because the prompt is rebuilt whole on every request rather
 * than patched from the middle of a conversation.
 */
export function getInitialSystemMessage(messages: readonly Message[]): SystemMessage | undefined {
	const first = messages[0];
	return first?.role === "system" ? first : undefined;
}

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}
