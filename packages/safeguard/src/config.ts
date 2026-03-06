import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetModelOptions as BudgetModelOptionsSchema } from "pi-budget-model";
import type { BudgetModelOptions } from "pi-budget-model";
import * as v from "valibot";

// --- Safeguard configuration schema ---

export const SafeguardConfig = v.object({
	/** Disable safeguard entirely */
	enabled: v.optional(v.boolean(), true),
	/** Judge model selection — embeds pi-budget-model options as-is */
	judgeModel: v.optional(BudgetModelOptionsSchema, {}),
	/** Judge call timeout in ms */
	judgeTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1000), v.maxValue(60_000)), 10_000),
});
export type SafeguardConfig = v.InferOutput<typeof SafeguardConfig>;

/** Config file location: ~/.pi/agent/extensions/pi-safeguard.json */
function configPath(): string {
	return join(process.env.HOME ?? "~", ".pi", "agent", "extensions", "pi-safeguard.json");
}

/** Load and validate config from disk. Returns defaults if file doesn't exist. */
export function loadSafeguardConfig(): SafeguardConfig {
	const path = configPath();
	let raw: unknown = {};
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		// File doesn't exist or is unreadable — use defaults
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`safeguard: failed to read config at ${path}: ${err instanceof Error ? err.message : err}`);
		}
	}
	try {
		return v.parse(SafeguardConfig, raw);
	} catch (err) {
		throw new Error(`safeguard: invalid config at ${path}: ${err instanceof Error ? err.message : err}`);
	}
}

/** Extract BudgetModelOptions from the safeguard config. */
export function toBudgetModelOptions(config: SafeguardConfig): BudgetModelOptions {
	return config.judgeModel;
}

// --- Constants ---

export const TRUST_ENTRY_TYPE = "safeguard:trust";
export const VERDICT_ENTRY_TYPE = "safeguard:verdict";

export const MAX_CONTEXT_TOOLS = 8;
export const USER_MSG_MAX = 300;
export const USER_MSG_HEAD = 150;
export const USER_MSG_TAIL = 100;
export const BASH_DETAIL_LEN = 50;

export const DEFAULT_DENY_GUIDANCE =
	"This action was blocked by the security guardrail. Consider a different approach, ask the user to run the command directly, or ask the user to grant access with /guard.";

export const SYSTEM_PROMPT = `You are a security guardrail for an AI coding agent. You evaluate actions that were flagged by automatic pattern matching.

Your job: decide if the action is safe to proceed WITHOUT interrupting the user.

You receive:
- The action (a bash command or file operation)
- The agent's working directory
- User trust directives for this session (if any — these are set by the user and should be respected)
- Recent agent activity with tool calls, outcomes, and any previous guard verdicts

Respond with exactly one JSON object:
{ "verdict": "approve" | "deny" | "ask", "reason": "<one sentence, shown to user>", "guidance": "<one sentence advice for the agent>" }

Verdicts:
- approve: routine and safe in a development context
- deny: genuinely dangerous or clearly malicious
- ask: you need the user to decide — use this when uncertain, OR when you suspect circumvention

The "guidance" field is sent to the agent instead of your reasoning. It should suggest what to do:
- Ask the user to provide the needed value directly instead of reading secrets
- Suggest the user run the command themselves via the terminal
- Suggest using /guard to add a trust directive if repeated access is needed
- Suggest an alternative approach that doesn't require the sensitive operation

Circumvention detection:
If a previous action was denied and the agent is now attempting the same goal via different commands (e.g. denied "cat .env", now trying "head .env" or "grep . .env"), respond with "ask" to let the user decide. Note: solving the problem differently and safely (e.g. asking the user to provide a value, using a different approach entirely) is NOT circumvention.

Be pragmatic. Developers work with these files and commands constantly. Err toward approve for typical dev workflows.`;
