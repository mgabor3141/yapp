/**
 * pi-bash-bg — Makes `command &` work in pi's bash tool.
 *
 * The bash tool pipes stdout/stderr from the spawned shell. When a command
 * backgrounds a process with `&`, the background process inherits these pipes
 * and keeps them open, causing the tool to hang until the process exits.
 *
 * This extension intercepts bash tool calls, parses the command with @aliou/sh
 * to detect background processes, and rewrites the command to redirect their
 * output to temp log files and disown them from job control. The shell then
 * exits cleanly and the bash tool returns immediately.
 *
 * The agent sees the PID, label, and log file path in the tool output,
 * and can check on the process with `cat <logfile>` or `kill <pid>`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { detectBackground } from "./detect.js";
import { rewriteCommand } from "./rewrite.js";

export { detectBackground, type BgStatement, type DetectResult } from "./detect.js";
export { rewriteCommand, findBgOperatorPositions, type BgProcessInfo, type RewriteResult } from "./rewrite.js";

export const BASH_BG_SYSTEM_PROMPT_SECTION = [
	"## Background jobs (`command &`)",
	"",
	"The bash tool supports backgrounding processes with `&`.",
	"Background process stdout/stderr is captured to a temp log file.",
	"Each rewritten command reports `[bg] pid=<PID> label=<LABEL> log=<PATH>` in its output.",
	"Use `cat <PATH>` to check output and `kill <PID>` to stop the process.",
].join("\n");

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		const { bgStatements } = detectBackground(command);
		if (bgStatements.length === 0) return;

		const { command: rewritten } = rewriteCommand(command, bgStatements);
		event.input.command = rewritten;
	});

	pi.on("before_agent_start", async (event) => {
		// Inject background-job guidance into the system prompt once per turn.
		// We avoid re-registering the bash tool because that would drop the
		// commandPrefix/shellPath/spawnHook options that pi's built-in bash
		// tool is constructed with, silently breaking `shellCommandPrefix`.
		if (event.systemPrompt.includes(BASH_BG_SYSTEM_PROMPT_SECTION)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${BASH_BG_SYSTEM_PROMPT_SECTION}`,
		};
	});
}
