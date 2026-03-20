/**
 * Wire protocol types and message serialization for remote-control.
 *
 * Converts pi session entries into the simplified RenderMsg format
 * consumed by the browser client.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface RenderMsg {
	id: string; // SessionEntry id, or "pending" while streaming
	role: "user" | "assistant" | "tool_result";
	text: string;
	toolCalls?: Array<{ id: string; name: string; args: string }>;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	model?: string;
}

export function serializeMessage(id: string, msg: any): RenderMsg | null {
	if (msg.role === "user") {
		const text =
			typeof msg.content === "string"
				? msg.content
				: (msg.content as any[])
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("");
		return { id, role: "user", text };
	}

	if (msg.role === "assistant") {
		const text = (msg.content as any[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		const toolCalls = (msg.content as any[])
			.filter((c) => c.type === "toolCall")
			.map((c) => ({
				id: c.id,
				name: c.name,
				args: JSON.stringify(c.arguments, null, 2),
			}));
		return {
			id,
			role: "assistant",
			text,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			model: msg.model,
		};
	}

	if (msg.role === "toolResult") {
		const text = (msg.content as any[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		return {
			id,
			role: "tool_result",
			text,
			toolName: msg.toolName,
			toolCallId: msg.toolCallId,
			isError: msg.isError,
		};
	}

	return null;
}

export function getBranchMessages(ctx: ExtensionContext): RenderMsg[] {
	const branch = ctx.sessionManager.getBranch();
	const out: RenderMsg[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const m = serializeMessage(entry.id, (entry as any).message);
		if (m) out.push(m);
	}
	return out;
}

export function buildSyncMessage(ctx: ExtensionContext): {
	type: "sync";
	messages: RenderMsg[];
	state: {
		isStreaming: boolean;
		model: string | undefined;
		cwd: string;
		sessionName: string | undefined;
	};
} {
	return {
		type: "sync",
		messages: getBranchMessages(ctx),
		state: {
			isStreaming: !ctx.isIdle(),
			model: ctx.model?.id,
			cwd: ctx.cwd,
			sessionName: ctx.sessionManager.getSessionName(),
		},
	};
}
