/**
 * pi-safeguard — LLM-as-judge guardrail for dangerous commands and sensitive file access.
 *
 * Architecture:
 *   1. Flagger (signals.ts) — wide net, boolean predicates, no reasoning.
 *      Answers "should the judge look at this?" with high recall.
 *   2. Judge (judge.ts) — sees the raw action + context, forms its own assessment.
 *      No hint about why the flagger triggered. Can approve, deny, or ask.
 *
 * When no budget model is available (e.g. user is already on the cheapest model),
 * falls back to "ask" mode — every flagged action prompts the user directly.
 *
 * Configuration:
 *   Global:  ~/.pi/agent/extensions/pi-safeguard.json
 *   Project: .pi/extensions/pi-safeguard.json (additive only)
 *
 * The agent never sees the judge's reasoning. On deny/ask it receives guidance
 * suggesting alternative approaches. Previous verdicts are stored in the
 * session and included in context so the judge can detect circumvention.
 *
 * Use /guard to add per-session trust directives, or the agent can propose
 * trust rules via the propose_trust tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type BudgetModel, findBudgetModel } from "pi-budget-model";
import {
	DEFAULT_DENY_GUIDANCE,
	type MergedConfig,
	TRUST_ENTRY_TYPE,
	VERDICT_ENTRY_TYPE,
	buildSystemPrompt,
	loadMergedConfig,
	toBudgetModelOptions,
} from "./config.js";
import { buildContext, getTrustDirectives } from "./context.js";
import { type BatchEntry, callJudge } from "./judge.js";
import { type SignalContext, describeAction, isRelevantTool, shouldFlag } from "./signals.js";
import type { VerdictData } from "./types.js";

export default function (pi: ExtensionAPI) {
	// Config is loaded once at startup using process.cwd() for project config.
	// A new pi session is needed to pick up config changes.
	const config = loadMergedConfig(process.cwd());

	if (!config.enabled) return;

	const systemPrompt = buildSystemPrompt(config);

	// --- /guard command ---

	pi.registerCommand("guard", {
		description: "Manage safeguard: /guard <trust directive> or /guard reset",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				const directives = getTrustDirectives(ctx);
				if (directives.length === 0) {
					ctx.ui.notify("No trust directives set for this session.");
				} else {
					ctx.ui.notify(`Trust directives:\n${directives.map((d, i) => `  ${i + 1}. ${d}`).join("\n")}`);
				}
				return;
			}
			if (trimmed === "reset") {
				pi.appendEntry(TRUST_ENTRY_TYPE, null);
				ctx.ui.notify("🛡️ Trust directives cleared for this session.");
				return;
			}
			pi.appendEntry(TRUST_ENTRY_TYPE, trimmed);
			ctx.ui.notify(`🛡️ Trust directive added: ${trimmed}`);
		},
	});

	// --- propose_trust tool ---

	pi.registerTool({
		name: "propose_trust",
		label: "Propose Trust Rule",
		description:
			"Request permission for something the security guardrail blocked. Proposes a trust rule for the user to accept or reject. Accepted rules instruct the security judge for the remainder of the session, so propose broad rules covering your task rather than one-off approvals.",
		promptSnippet:
			"Request permission for something the security guardrail blocked (proposes a session-wide trust rule for the user to approve)",
		promptGuidelines: [
			"When blocked by the security guardrail, use propose_trust to request permission instead of asking the user to type /guard manually.",
			"Accepted rules last for the entire session, so propose rules that cover the task broadly rather than one-off approvals.",
			"Keep rules brief but explicit about what is allowed. Good: 'Allow .env file access', 'Allow terraform plan and apply'. Bad: 'Allow dangerous commands', 'Allow everything needed for this task'.",
			"The reason field is optional. Only include it if the rule isn't self-explanatory. Don't repeat information from the rule.",
		],
		parameters: Type.Object({
			rule: Type.String({
				description:
					"Brief, explicit trust rule stating what is allowed (e.g. 'Allow .env file access', 'Allow terraform commands', 'Allow editing safeguard source')",
			}),
			reason: Type.Optional(
				Type.String({
					description: "Only if the rule isn't self-explanatory. Don't repeat the rule.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) {
				return {
					content: [{ type: "text", text: "Rejected: no UI context available." }],
					details: {},
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Rejected: no interactive UI available." }],
					details: {},
				};
			}

			const lines = ["🛡️ Trust rule proposed", `\n📋 ${params.rule}`];
			if (params.reason) lines.push(`\n💬 ${params.reason}`);
			lines.push("");

			const choice = await ctx.ui.select(lines.join("\n"), ["Accept", "Reject"]);

			if (choice === "Accept") {
				pi.appendEntry(TRUST_ENTRY_TYPE, params.rule);
				return {
					content: [
						{
							type: "text",
							text: `Trust rule accepted for this session: "${params.rule}". You can now retry the blocked action.`,
						},
					],
					details: {},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "Trust rule rejected by user. Try a different approach, or ask the user to run the command directly.",
					},
				],
				details: {},
			};
		},
	});

	// --- Tool call interception ---

	/**
	 * Turn-level tracking for batch awareness and circumvention detection.
	 *
	 * When the agent plans multiple tool calls in one turn, they arrive
	 * sequentially but were planned together (before any verdicts). We track:
	 * - currentTurnBatch: actions evaluated so far in this turn (with verdicts)
	 * - denialInPreviousTurn: whether the previous turn had a denial
	 *
	 * Circumvention checks only trigger across turn boundaries, never within
	 * a batch. The judge receives batch context so it knows which actions were
	 * planned together.
	 */
	let currentTurnBatch: BatchEntry[] = [];
	let denialInCurrentTurn = false;
	let denialInPreviousTurn = false;
	/** Accumulated verdicts shown in the widget across the entire agent flow. */
	let flowVerdicts: { action: string; verdict: string; reason: string }[] = [];

	pi.on("agent_start", async (_event, ctx) => {
		currentTurnBatch = [];
		denialInCurrentTurn = false;
		denialInPreviousTurn = false;
		flowVerdicts = [];
		ctx.ui.setWidget("safeguard", undefined);
	});

	pi.on("turn_start", async () => {
		denialInPreviousTurn = denialInCurrentTurn;
		denialInCurrentTurn = false;
		currentTurnBatch = [];
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Clear the widget when the agent goes idle and returns to the user
		if (flowVerdicts.length > 0) {
			ctx.ui.setWidget("safeguard", undefined);
			flowVerdicts = [];
		}
	});

	pi.on("tool_call", async (event, ctx): Promise<{ block: true; reason: string } | undefined> => {
		const signalCtx: SignalContext = {
			cwd: ctx.cwd,
			home: process.env.HOME ?? "/home",
		};

		let flagged = shouldFlag(event, signalCtx, config);

		// Post-denial circumvention: check across turn boundaries, not within a batch
		if (!flagged && denialInPreviousTurn && isRelevantTool(event)) {
			flagged = true;
		}

		if (!flagged) return;

		const action = describeAction(event);
		const batchContext = currentTurnBatch.length > 0 ? [...currentTurnBatch] : undefined;
		const result = await evaluate(pi, ctx, config, systemPrompt, action, batchContext, flowVerdicts);

		// Track this evaluation in the batch
		const verdict = result ? "deny" : "approve";
		currentTurnBatch.push({ action, verdict });

		if (result) {
			denialInCurrentTurn = true;
		}

		// Clear previous-turn circumvention flag after first check in new turn
		if (denialInPreviousTurn) {
			denialInPreviousTurn = false;
		}

		return result;
	});
}

// --- Core: evaluate ---

async function evaluate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: MergedConfig,
	systemPrompt: string,
	action: string,
	batchContext: BatchEntry[] | undefined,
	flowVerdicts: { action: string; verdict: string; reason: string }[],
): Promise<{ block: true; reason: string } | undefined> {
	let judge: BudgetModel;
	try {
		judge = await resolveJudgeModel(ctx, config);
	} catch {
		return askUser(pi, ctx, action, "No judge model available — manual approval required.");
	}

	const recentContext = buildContext(ctx);
	const trustDirectives = getTrustDirectives(ctx);

	try {
		const verdict = await callJudge(
			judge.model,
			judge.auth,
			action,
			ctx.cwd,
			recentContext,
			trustDirectives,
			config.judgeTimeoutMs,
			systemPrompt,
			batchContext,
		);

		if (verdict.verdict === "approve") {
			flowVerdicts.push({ action, verdict: "✅", reason: verdict.reason });
			updateWidget(ctx, flowVerdicts);
			pi.appendEntry(VERDICT_ENTRY_TYPE, {
				action,
				verdict: "approve",
				reason: verdict.reason,
			} satisfies VerdictData);
			return;
		}

		if (verdict.verdict === "deny") {
			flowVerdicts.push({ action, verdict: "❌", reason: verdict.reason });
			updateWidget(ctx, flowVerdicts);
			pi.appendEntry(VERDICT_ENTRY_TYPE, { action, verdict: "deny", reason: verdict.reason } satisfies VerdictData);
			return { block: true, reason: verdict.guidance || DEFAULT_DENY_GUIDANCE };
		}

		return askUser(pi, ctx, action, verdict.reason);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return askUser(pi, ctx, action, `Judge error: ${msg}`);
	}
}

/** Update the widget with accumulated verdict counts for the current agent flow. */
function updateWidget(ctx: ExtensionContext, verdicts: { action: string; verdict: string; reason: string }[]): void {
	const approved = verdicts.filter((v) => v.verdict === "✅").length;
	const denied = verdicts.filter((v) => v.verdict === "❌").length;
	const parts: string[] = [];
	if (approved > 0) parts.push(`${approved} approved`);
	if (denied > 0) parts.push(`${denied} denied`);
	ctx.ui.setWidget("safeguard", [`🛡️ ${parts.join(", ")}`]);
}

// --- Judge model resolution ---

async function resolveJudgeModel(ctx: ExtensionContext, config: MergedConfig): Promise<BudgetModel> {
	return findBudgetModel(ctx, toBudgetModelOptions(config));
}

// --- User interaction ---

async function askUser(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: string,
	explanation: string,
): Promise<{ block: true; reason: string } | undefined> {
	if (!ctx.hasUI) {
		pi.appendEntry(VERDICT_ENTRY_TYPE, { action, verdict: "user-deny", reason: "no UI" } satisfies VerdictData);
		return { block: true, reason: DEFAULT_DENY_GUIDANCE };
	}

	const lines = ["Command needs approval. Agent's explanation:", `> ${explanation}`, `\n${action}`];
	const choice = await ctx.ui.select(lines.join("\n"), ["Allow", "Deny", "Stop"]);

	if (choice === "Allow") {
		pi.appendEntry(VERDICT_ENTRY_TYPE, { action, verdict: "user-approve", reason: explanation } satisfies VerdictData);
		return;
	}

	if (choice === "Stop") {
		pi.appendEntry(VERDICT_ENTRY_TYPE, { action, verdict: "user-deny", reason: "user stopped" } satisfies VerdictData);
		ctx.abort();
		return { block: true, reason: "The user stopped execution. Wait for their next instructions." };
	}

	pi.appendEntry(VERDICT_ENTRY_TYPE, { action, verdict: "user-deny", reason: explanation } satisfies VerdictData);
	return { block: true, reason: DEFAULT_DENY_GUIDANCE };
}
