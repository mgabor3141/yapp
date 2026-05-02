import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { BudgetModelAuth } from "pi-budget-model";
import type { Verdict } from "./types.js";

export function parseVerdict(text: string): Verdict {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error(`no JSON object found in response: ${text.slice(0, 200)}`);
	}
	const parsed = JSON.parse(text.slice(start, end + 1));
	if (!["approve", "deny", "ask"].includes(parsed.verdict)) {
		throw new Error(`invalid verdict "${parsed.verdict}" in response: ${text.slice(0, 200)}`);
	}
	return { verdict: parsed.verdict, reason: parsed.reason ?? "", guidance: parsed.guidance ?? "" };
}

/** A tool call evaluated earlier in the same turn (batch). */
export interface BatchEntry {
	action: string;
	verdict: "approve" | "deny" | "ask" | "pending";
}

export async function callJudge(
	model: Model<Api>,
	auth: BudgetModelAuth,
	action: string,
	cwd: string,
	recentContext: string,
	trustDirectives: string[],
	timeoutMs: number,
	systemPrompt: string,
	batchContext?: BatchEntry[],
): Promise<Verdict> {
	const parts = [`Action: ${action}`, `Working directory: ${cwd}`];
	if (batchContext && batchContext.length > 0) {
		parts.push(
			"",
			"Batch context: the agent planned multiple tool calls at once (before receiving any verdicts). Other calls in this batch:",
			...batchContext.map((b) => `  - [${b.verdict}] ${b.action}`),
		);
	}
	if (trustDirectives.length > 0) {
		parts.push("", "User trust directives:", ...trustDirectives.map((d) => `  - ${d}`));
	}
	if (recentContext) {
		parts.push("", "Recent activity:", recentContext);
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: parts.join("\n"), timestamp: Date.now() }],
			},
			{
				...auth,
				signal: controller.signal,
				maxTokens: 250,
				temperature: 0,
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		return parseVerdict(text);
	} finally {
		clearTimeout(timeout);
	}
}
