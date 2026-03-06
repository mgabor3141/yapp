import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionContext, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import {
	BASH_DETAIL_LEN,
	MAX_CONTEXT_TOOLS,
	TRUST_ENTRY_TYPE,
	USER_MSG_HEAD,
	USER_MSG_MAX,
	USER_MSG_TAIL,
	VERDICT_ENTRY_TYPE,
} from "./config.js";
import type { VerdictData } from "./types.js";
import { isCustomEntry } from "./types.js";

/** Get active trust directives from the session (handles reset via null sentinel). */
export function getTrustDirectives(ctx: ExtensionContext): string[] {
	const directives: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (isCustomEntry<string | null>(entry, TRUST_ENTRY_TYPE)) {
			if (entry.data === null) directives.length = 0;
			else directives.push(entry.data);
		}
	}
	return directives;
}

/** Check if the last verdict (before the current user message) was a denial. */
export function wasLastVerdictDenial(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isCustomEntry<VerdictData>(entry, VERDICT_ENTRY_TYPE)) {
			return entry.data.verdict === "deny" || entry.data.verdict === "user-deny";
		}
		if (entry.type === "message" && (entry as SessionMessageEntry).message.role === "user") {
			return false;
		}
	}
	return false;
}

/** Build a context summary for the LLM judge — scoped from last user message, capped at recent tools. */
export function buildContext(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();

	// Find last user message
	let userIdx = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "message" && (branch[i] as SessionMessageEntry).message.role === "user") {
			userIdx = i;
			break;
		}
	}

	let userLine = "";
	const toolLines: string[] = [];
	const pendingCalls: { name: string; summary: string }[] = [];
	let pendingVerdict: VerdictData | null = null;
	const start = userIdx >= 0 ? userIdx : Math.max(0, branch.length - 20);

	for (let i = start; i < branch.length; i++) {
		const entry = branch[i];

		if (isCustomEntry<VerdictData>(entry, VERDICT_ENTRY_TYPE)) {
			pendingVerdict = entry.data;
			continue;
		}

		if (entry.type !== "message") continue;
		const msg = (entry as SessionMessageEntry).message;

		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is TextContent => c.type === "text")
							.map((c) => c.text)
							.join(" ");
			userLine = `[user] ${abbreviate(text)}`;
			continue;
		}

		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					// biome-ignore lint/suspicious/noExplicitAny: untyped tool call arguments
					const tc = block as { name: string; arguments: Record<string, any> };
					pendingCalls.push({ name: tc.name, summary: summarizeToolCall(tc.name, tc.arguments) });
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const call = pendingCalls.shift();
			const callStr = call?.summary ?? msg.toolName;

			if (pendingVerdict && pendingVerdict.verdict !== "approve") {
				toolLines.push(`[tool] ${callStr} → ${pendingVerdict.verdict} (${pendingVerdict.reason})`);
			} else {
				const outcome = msg.isError ? "error" : "ok";
				const detail = msg.toolName === "bash" ? bashDetail(msg.content) : "";
				toolLines.push(`[tool] ${callStr} → ${outcome}${detail}`);
			}
			pendingVerdict = null;
		}
	}

	const lines: string[] = [];
	if (userLine) lines.push(userLine);
	if (toolLines.length > MAX_CONTEXT_TOOLS) {
		const omitted = toolLines.length - MAX_CONTEXT_TOOLS;
		lines.push(`[${omitted} previous tool calls omitted]`);
		lines.push(...toolLines.slice(-MAX_CONTEXT_TOOLS));
	} else {
		lines.push(...toolLines);
	}

	return lines.join("\n");
}

function abbreviate(text: string): string {
	if (text.length <= USER_MSG_MAX) return text;
	return `${text.slice(0, USER_MSG_HEAD)}…${text.slice(-USER_MSG_TAIL)}`;
}

// biome-ignore lint/suspicious/noExplicitAny: untyped tool call arguments
function summarizeToolCall(name: string, args: Record<string, any>): string {
	if (name === "bash") return `bash: ${args.command ?? ""}`;
	if (["read", "write", "edit", "grep", "find", "ls"].includes(name)) return `${name} ${args.path ?? ""}`;
	return name;
}

function bashDetail(content: { type: string; text?: string }[]): string {
	const text = content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
	const lastLine = text.trim().split("\n").pop()?.trim() ?? "";
	if (!lastLine) return "";
	const trimmed = lastLine.length > BASH_DETAIL_LEN ? lastLine.slice(-BASH_DETAIL_LEN) : lastLine;
	return ` | ${trimmed}`;
}
