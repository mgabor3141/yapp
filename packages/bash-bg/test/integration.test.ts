import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectBackground } from "../src/detect.js";
import { rewriteCommand } from "../src/rewrite.js";

/**
 * Integration tests: verify that rewritten commands actually run without
 * hanging and produce the expected output files.
 */
describe("integration", () => {
	/** Detect + rewrite, then execute in bash. Returns stdout. */
	function execRewritten(command: string, timeoutMs = 5000): string {
		const { bgStatements } = detectBackground(command);
		const { command: rewritten, processes } = rewriteCommand(command, bgStatements);

		try {
			const stdout = execSync(`bash -c ${shellQuote(rewritten)}`, {
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return stdout;
		} finally {
			// Clean up log files
			for (const p of processes) {
				try {
					unlinkSync(p.logFile);
				} catch {}
			}
			// Kill any background processes that might still be running
			try {
				execSync("pkill -f 'pi-bash-bg-test-marker' 2>/dev/null || true", { encoding: "utf-8" });
			} catch {}
		}
	}

	function shellQuote(s: string): string {
		return `'${s.replace(/'/g, "'\\''")}'`;
	}

	it("simple background command does not hang", () => {
		// This would hang without the rewrite (sleep holds pipes open)
		const output = execRewritten("sleep 300 &");
		expect(output).toContain("[bg]");
		expect(output).toContain("pid=");
		expect(output).toMatch(/log=.*\/pi-bg-/);

		// Clean up the sleep process
		const pidMatch = output.match(/pid=(\d+)/);
		if (pidMatch) {
			try {
				process.kill(Number(pidMatch[1]), "SIGTERM");
			} catch {}
		}
	});

	it("background process output goes to log file", () => {
		const { bgStatements } = detectBackground('echo "pi-bash-bg-test-output" &');
		const { command: rewritten, processes } = rewriteCommand('echo "pi-bash-bg-test-output" &', bgStatements);
		const logFile = processes[0].logFile;

		try {
			execSync(`bash -c ${shellQuote(rewritten)}`, {
				timeout: 5000,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});

			// Give the background process a moment to write
			execSync("sleep 0.2");

			expect(existsSync(logFile)).toBe(true);
			const logContent = readFileSync(logFile, "utf-8");
			expect(logContent).toContain("pi-bash-bg-test-output");
		} finally {
			try {
				unlinkSync(logFile);
			} catch {}
		}
	});

	it("foreground output is preserved alongside background", () => {
		const output = execRewritten('echo "foreground-output"; sleep 300 &');
		expect(output).toContain("foreground-output");
		expect(output).toContain("[bg]");

		// Clean up
		const pidMatch = output.match(/pid=(\d+)/);
		if (pidMatch) {
			try {
				process.kill(Number(pidMatch[1]), "SIGTERM");
			} catch {}
		}
	});

	it("logical chain with background does not hang", () => {
		const output = execRewritten("true && sleep 300 &");
		expect(output).toContain("[bg]");

		const pidMatch = output.match(/pid=(\d+)/);
		if (pidMatch) {
			try {
				process.kill(Number(pidMatch[1]), "SIGTERM");
			} catch {}
		}
	});

	it("already-redirected simple command does not hang", () => {
		const output = execRewritten("sleep 300 > /dev/null 2>&1 &");

		expect(output).toContain("[bg]");
		expect(output).toContain("pid=");
		// No log path reported since output is already redirected
		expect(output).not.toContain("log=");

		const pidMatch = output.match(/pid=(\d+)/);
		if (pidMatch) {
			try {
				process.kill(Number(pidMatch[1]), "SIGTERM");
			} catch {}
		}
	});

	it("compound command with inner redirects does not hang", () => {
		// This is the critical regression test: inner redirects on the last
		// command don't prevent the background subshell from holding pipes.
		// Without brace wrapping, this would hang.
		const output = execRewritten("true && sleep 300 > /dev/null 2>&1 &");
		expect(output).toContain("[bg]");

		const pidMatch = output.match(/pid=(\d+)/);
		if (pidMatch) {
			try {
				process.kill(Number(pidMatch[1]), "SIGTERM");
			} catch {}
		}
	});
});
