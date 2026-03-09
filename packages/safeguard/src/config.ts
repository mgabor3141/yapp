import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetModelOptions as BudgetModelOptionsSchema } from "pi-budget-model";
import type { BudgetModelOptions } from "pi-budget-model";
import * as v from "valibot";

// --- Safeguard configuration schemas ---

/** A command matcher: either a command name or [command, ...subcommands] prefix. */
const CommandMatcher = v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))]);
export type CommandMatcher = v.InferOutput<typeof CommandMatcher>;

/** Fields shared between global and project config — additive, merged across layers. */
const SharedConfig = v.object({
	/** Command names to flag. String = any invocation; array = subcommand prefix match. */
	commands: v.optional(v.array(CommandMatcher), []),
	/** Regex patterns to flag anywhere in tool input text. */
	patterns: v.optional(v.array(v.string()), []),
	/** Natural language instructions appended to the judge system prompt. */
	instructions: v.optional(v.string()),
});

/** Global config: shared fields + operational settings. */
export const SafeguardConfig = v.object({
	...SharedConfig.entries,
	/** Disable safeguard entirely (global only) */
	enabled: v.optional(v.boolean(), true),
	/** Judge model selection (global only) */
	judgeModel: v.optional(BudgetModelOptionsSchema, {}),
	/** Judge call timeout in ms (global only) */
	judgeTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1000), v.maxValue(60_000)), 10_000),
});
export type SafeguardConfig = v.InferOutput<typeof SafeguardConfig>;

/** Project config: shared fields only — cannot weaken operational settings. */
export const ProjectConfig = SharedConfig;
export type ProjectConfig = v.InferOutput<typeof ProjectConfig>;

/** Merged config used at runtime. */
export interface MergedConfig {
	enabled: boolean;
	judgeModel: BudgetModelOptions;
	judgeTimeoutMs: number;
	commands: CommandMatcher[];
	patterns: RegExp[];
	globalInstructions?: string;
	projectInstructions?: string;
}

// --- Config file paths ---

function globalConfigPath(): string {
	return join(process.env.HOME ?? "~", ".pi", "agent", "extensions", "pi-safeguard.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "extensions", "pi-safeguard.json");
}

// --- Config loading ---

function readJsonFile(path: string, label: string): unknown | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(
			`safeguard: failed to read ${label} config at ${path}: ${err instanceof Error ? err.message : err}`,
		);
	}
}

function parseConfig<T>(schema: v.GenericSchema<unknown, T>, raw: unknown, path: string, label: string): T {
	try {
		return v.parse(schema, raw);
	} catch (err) {
		throw new Error(`safeguard: invalid ${label} config at ${path}: ${err instanceof Error ? err.message : err}`);
	}
}

/** Compile user-provided regex strings into RegExp objects. Throws on invalid regex. */
function compilePatterns(patterns: string[], label: string): RegExp[] {
	return patterns.map((p) => {
		try {
			return new RegExp(p);
		} catch (err) {
			throw new Error(
				`safeguard: invalid regex in ${label} patterns: "${p}" — ${err instanceof Error ? err.message : err}`,
			);
		}
	});
}

/** Load global config. Returns defaults if file doesn't exist. */
export function loadGlobalConfig(): SafeguardConfig {
	const path = globalConfigPath();
	const raw = readJsonFile(path, "global") ?? {};
	return parseConfig(SafeguardConfig, raw, path, "global");
}

/** Load project config from cwd. Returns undefined if file doesn't exist. */
export function loadProjectConfig(cwd: string): ProjectConfig | undefined {
	const path = projectConfigPath(cwd);
	const raw = readJsonFile(path, "project");
	if (raw === undefined) return undefined;
	return parseConfig(ProjectConfig, raw, path, "project");
}

/** Load and merge global + project config into a single runtime config. */
export function loadMergedConfig(cwd: string): MergedConfig {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(cwd);

	const commands = [...global.commands];
	const patternStrs = [...global.patterns];

	if (project) {
		commands.push(...project.commands);
		patternStrs.push(...project.patterns);
	}

	return {
		enabled: global.enabled,
		judgeModel: global.judgeModel,
		judgeTimeoutMs: global.judgeTimeoutMs,
		commands,
		patterns: compilePatterns(patternStrs, project ? "global+project" : "global"),
		globalInstructions: global.instructions,
		projectInstructions: project?.instructions,
	};
}

/** Extract BudgetModelOptions from the merged config. */
export function toBudgetModelOptions(config: MergedConfig): BudgetModelOptions {
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
	"This action was blocked by the security guardrail. Consider a different approach, ask the user to run the command directly, or use the propose_trust tool to request permission for this session.";

const BASE_SYSTEM_PROMPT = `You are a security guardrail for an AI coding agent. You evaluate actions before they execute.

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

/** Build the full judge system prompt with optional user/project instructions. */
export function buildSystemPrompt(config: MergedConfig): string {
	const parts = [BASE_SYSTEM_PROMPT];

	if (config.globalInstructions) {
		parts.push(`\n\nUser instructions (global):\n${config.globalInstructions}`);
	}
	if (config.projectInstructions) {
		parts.push(`\n\nProject instructions:\n${config.projectInstructions}`);
	}

	return parts.join("");
}
