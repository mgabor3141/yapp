/**
 * Command rewriting for background processes.
 *
 * Takes a bash command string and the detection results, then rewrites
 * background commands to:
 * 1. Redirect stdout/stderr to temp log files (if not already redirected)
 * 2. Add `disown` to detach from job control (if not already present)
 * 3. Append echo statements reporting PID, label, and log path
 *
 * This prevents background processes from holding the bash tool's pipes
 * open, which would otherwise hang the tool call indefinitely.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BgStatement } from "./detect.js";

/** Info about a background process started by the rewritten command. */
export interface BgProcessInfo {
	/** Unique index for this background process within the command. */
	index: number;
	/** Human-readable label from AST analysis. */
	label: string;
	/** Path to the log file capturing stdout/stderr. */
	logFile: string;
}

/** Result of rewriting a command. */
export interface RewriteResult {
	/** The rewritten command string. */
	command: string;
	/** Info about each background process. */
	processes: BgProcessInfo[];
}

/**
 * Find the positions of background `&` operators in the command text.
 *
 * Walks the string tracking quote state to distinguish real operators
 * from `&` inside strings. Skips `&&`, `&>`, `>&`.
 */
export function findBgOperatorPositions(text: string): number[] {
	const positions: number[] = [];
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		if (escaped) {
			escaped = false;
			continue;
		}

		const ch = text[i];

		if (ch === "\\" && !inSingle) {
			escaped = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;

		if (ch === "&") {
			const next = text[i + 1];
			const prev = i > 0 ? text[i - 1] : "";
			// Skip &&, &>, >&
			if (next === "&" || next === ">") {
				i++; // Skip the next char too
				continue;
			}
			if (prev === ">") continue;
			positions.push(i);
		}
	}

	return positions;
}

/**
 * Generate a unique log file path for a background process.
 */
function makeLogPath(runId: string, index: number): string {
	return join(tmpdir(), `pi-bg-${runId}-${index}.log`);
}

/**
 * Rewrite a bash command to detach background processes from pipes.
 *
 * Strategy: find each `&` operator position, then working from end to start
 * (to keep positions stable), insert redirections and disown.
 */
export function rewriteCommand(command: string, bgStatements: BgStatement[]): RewriteResult {
	if (bgStatements.length === 0) {
		return { command, processes: [] };
	}

	const bgPositions = findBgOperatorPositions(command);
	if (bgPositions.length === 0) {
		// AST says there are background commands but we can't find them in text.
		// This shouldn't happen, but fall through safely.
		return { command, processes: [] };
	}

	// Match AST background statements to text positions.
	// Both are in order, so we zip them. If counts differ (shouldn't happen),
	// process only what we can match.
	const matchCount = Math.min(bgStatements.length, bgPositions.length);
	const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const processes: BgProcessInfo[] = [];

	let result = command;

	// Work from end to start so insertions don't shift earlier positions
	for (let i = matchCount - 1; i >= 0; i--) {
		const stmt = bgStatements[i];
		const ampPos = bgPositions[i];
		const logFile = makeLogPath(runId, i);

		processes.unshift({
			index: i,
			label: stmt.label,
			logFile,
		});

		const beforeAmp = result.slice(0, ampPos);
		const afterAmp = result.slice(ampPos + 1);
		const fullyRedirected = stmt.hasStdoutRedirect && stmt.hasStderrRedirect;

		let rewritten: string;

		if (fullyRedirected) {
			// Both stdout and stderr already redirected; keep command as-is
			rewritten = `${beforeAmp}&`;
		} else if (stmt.isCompound) {
			// Compound command (&&, ||, pipeline, etc.): wrap in braces so the
			// redirect applies to the entire background subshell, not just the
			// last simple command in the chain.
			rewritten = `{ ${beforeAmp.trimEnd()}; } > ${logFile} 2>&1 &`;
		} else if (!stmt.hasStdoutRedirect && !stmt.hasStderrRedirect) {
			// Simple command with no redirections
			rewritten = `${beforeAmp.trimEnd()} > ${logFile} 2>&1 &`;
		} else {
			// Simple command with stdout redirected but not stderr
			rewritten = `${beforeAmp.trimEnd()} 2>&1 &`;
		}

		// Add disown if not already present
		if (!stmt.followedByDisown) {
			rewritten += " disown $!;";
		}

		result = rewritten + afterAmp;
	}

	// Append echo statements for each background process
	const echoes = processes.map((p) => `echo "[bg] pid=$! label=${shellEscape(p.label)} log=${p.logFile}"`);

	// We need per-process PIDs, so we capture $! after each & instead.
	// Rewrite the echoes to use captured PIDs.
	const echoBlock = buildEchoBlock(processes);

	result = `${result.trimEnd()}\n${echoBlock}`;

	return { command: result, processes };
}

/**
 * Build the trailing echo block that reports background process info.
 *
 * For a single background process, $! gives us the PID directly.
 * For multiple, we capture each PID into a variable after each &.
 * Since we can't easily inject PID capture between existing commands
 * without a second rewrite pass, we use a simpler approach for the
 * common single-process case and a best-effort approach for multiple.
 */
function buildEchoBlock(processes: BgProcessInfo[]): string {
	if (processes.length === 1) {
		const p = processes[0];
		return `echo "[bg] pid=$! label=${shellEscape(p.label)} log=${p.logFile}"`;
	}

	// For multiple background processes, $! only holds the last PID.
	// Report what we can: labels and log files are known, only the last PID is available.
	const lines: string[] = [];
	for (let i = 0; i < processes.length; i++) {
		const p = processes[i];
		if (i === processes.length - 1) {
			lines.push(`echo "[bg:${i}] pid=$! label=${shellEscape(p.label)} log=${p.logFile}"`);
		} else {
			lines.push(`echo "[bg:${i}] label=${shellEscape(p.label)} log=${p.logFile}"`);
		}
	}
	return lines.join("\n");
}

/** Escape a string for safe inclusion in a shell echo (no quoting, just sanitize). */
function shellEscape(s: string): string {
	// Replace characters that could break the echo
	return s.replace(/['"\\$`!]/g, "");
}
