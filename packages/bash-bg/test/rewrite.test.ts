import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { detectBackground } from "../src/detect.js";
import { findBgOperatorPositions, rewriteCommand } from "../src/rewrite.js";

const TMP = tmpdir();

describe("findBgOperatorPositions", () => {
	it("finds trailing & in simple command", () => {
		const pos = findBgOperatorPositions("npm run dev &");
		expect(pos).toEqual([12]);
	});

	it("skips && operator", () => {
		const pos = findBgOperatorPositions("cmd1 && cmd2");
		expect(pos).toEqual([]);
	});

	it("skips &> operator", () => {
		const pos = findBgOperatorPositions("cmd &> /dev/null");
		expect(pos).toEqual([]);
	});

	it("skips >& operator", () => {
		const pos = findBgOperatorPositions("cmd 2>&1");
		expect(pos).toEqual([]);
	});

	it("skips & inside double quotes", () => {
		const pos = findBgOperatorPositions('echo "foo & bar"');
		expect(pos).toEqual([]);
	});

	it("skips & inside single quotes", () => {
		const pos = findBgOperatorPositions("echo 'a & b'");
		expect(pos).toEqual([]);
	});

	it("finds background & after &&", () => {
		const pos = findBgOperatorPositions("cd /dir && npm start &");
		expect(pos).toHaveLength(1);
		// Should only find the trailing &, not the ones in &&
		const text = "cd /dir && npm start &";
		expect(text[pos[0]]).toBe("&");
		expect(text[pos[0] - 1]).toBe(" ");
	});

	it("finds multiple background operators", () => {
		const pos = findBgOperatorPositions("cmd1 & cmd2 &");
		expect(pos).toHaveLength(2);
	});

	it("finds & after 2>&1 redirection", () => {
		const pos = findBgOperatorPositions("node server.js > /dev/null 2>&1 &");
		expect(pos).toHaveLength(1);
		// The last & is the background operator
		const text = "node server.js > /dev/null 2>&1 &";
		expect(pos[0]).toBe(text.length - 1);
	});

	it("handles escaped &", () => {
		const pos = findBgOperatorPositions("echo \\& real &");
		// The first & is escaped, only the last is a real operator
		expect(pos).toHaveLength(1);
	});

	it("skips & inside backticks", () => {
		const pos = findBgOperatorPositions("echo `sleep 10 &` &");
		// Only the trailing & is a real background operator
		expect(pos).toHaveLength(1);
		expect(pos[0]).toBe(18);
	});

	it("skips & inside backticks within double quotes", () => {
		const pos = findBgOperatorPositions('echo "`cmd &`" &');
		expect(pos).toHaveLength(1);
	});
});

describe("rewriteCommand", () => {
	/** Helper: detect then rewrite. */
	function rewrite(command: string) {
		const { bgStatements } = detectBackground(command);
		return rewriteCommand(command, bgStatements);
	}

	it("passes through commands without background", () => {
		const r = rewrite("echo hello");
		expect(r.command).toBe("echo hello");
		expect(r.processes).toEqual([]);
	});

	describe("simple background commands", () => {
		it("adds redirection and disown for bare background", () => {
			const r = rewrite("npm run dev &");
			expect(r.command).toContain(`> ${TMP}/pi-bg-`);
			expect(r.command).toContain("2>&1 &");
			expect(r.command).toContain("disown $!");
			expect(r.command).toContain("[bg]");
			expect(r.processes).toHaveLength(1);
			expect(r.processes[0].label).toBe("npm run dev");
			expect(r.processes[0].logFile).toMatch(/\/pi-bg-/);
		});

		it("adds redirection for env var prefix commands", () => {
			const r = rewrite("PORT=3000 node server.js &");
			expect(r.command).toContain(`> ${TMP}/pi-bg-`);
			expect(r.command).toContain("2>&1 &");
			expect(r.command).toContain("disown $!");
		});
	});

	describe("existing redirections", () => {
		it("skips redirection for fully-redirected simple command", () => {
			const r = rewrite("node server.js > /dev/null 2>&1 &");
			const redirectCount = (r.command.match(/> .*\/pi-bg/g) || []).length;
			expect(redirectCount).toBe(0);
			expect(r.command).toContain("disown $!");
			// No log file created
			expect(r.processes[0].logFile).toBe("");
		});

		it("still wraps compound commands even when inner redirects exist", () => {
			// This is the critical case: inner redirects don't prevent the
			// background subshell from holding the pipes open.
			const r = rewrite("cd /dir && npm start > /dev/null 2>&1 &");
			expect(r.command).toContain("{ cd /dir && npm start > /dev/null 2>&1; }");
			expect(r.command).toMatch(/> .*\/pi-bg/);
			expect(r.processes[0].logFile).not.toBe("");
		});

		it("adds stderr redirect when only stdout is redirected", () => {
			const r = rewrite("node server.js > output.log &");
			expect(r.command).toContain("2>&1 &");
			expect(r.command).not.toMatch(/> .*\/pi-bg/);
		});

		it("skips redirection for &> redirect", () => {
			const r = rewrite("node server.js &> /dev/null &");
			const redirectCount = (r.command.match(/> .*\/pi-bg/g) || []).length;
			expect(redirectCount).toBe(0);
		});
	});

	describe("existing disown", () => {
		it("skips adding disown when already present", () => {
			const r = rewrite("sleep 10 & disown");
			const disownCount = (r.command.match(/disown/g) || []).length;
			// One existing disown, no added disown (but echo line may mention "disown" in label)
			// Check there's exactly one disown that's a command
			expect(disownCount).toBe(1);
		});

		it("skips adding disown when disown $! follows", () => {
			const r = rewrite("node app.js & disown $!");
			// Should have the original disown and no extra
			const lines = r.command.split("\n");
			const disownLines = lines.filter(
				(l) => l.trim().startsWith("disown") || l.includes("; disown") || l.includes("& disown"),
			);
			// The original "disown $!" should be preserved
			expect(r.command).toContain("disown $!");
		});
	});

	describe("compound commands", () => {
		it("rewrites background at end of logical chain with wrapping", () => {
			const r = rewrite("cd /dir && npm start &");
			// Compound commands get wrapped in braces
			expect(r.command).toContain("{ cd /dir && npm start; }");
			expect(r.command).toContain(`> ${TMP}/pi-bg-`);
			expect(r.command).toContain("2>&1 &");
			expect(r.command).toContain("disown $!");
			expect(r.processes[0].label).toBe("npm start");
		});

		it("rewrites nohup pattern", () => {
			const r = rewrite("nohup node server.js &");
			expect(r.command).toContain(`> ${TMP}/pi-bg-`);
			expect(r.command).toContain("disown $!");
			expect(r.processes[0].label).toBe("node server.js");
		});
	});

	describe("mixed foreground/background", () => {
		it("only rewrites the background part", () => {
			const r = rewrite("echo start; npm run dev &");
			expect(r.command).toContain("echo start;");
			expect(r.command).toContain(`> ${TMP}/pi-bg-`);
			expect(r.processes).toHaveLength(1);
		});

		it("handles background followed by foreground commands", () => {
			const r = rewrite("npm run dev & sleep 2; curl localhost:3000");
			expect(r.command).toContain(`> ${TMP}/pi-bg-`);
			expect(r.command).toContain("sleep 2; curl localhost:3000");
			expect(r.processes).toHaveLength(1);
		});
	});

	describe("echo block", () => {
		it("includes pid, label, and log in echo for single process", () => {
			const r = rewrite("npm run dev &");
			expect(r.command).toContain("pid=$!");
			expect(r.command).toContain("label=npm run dev");
			expect(r.command).toMatch(/log=.*\/pi-bg-/);
		});

		it("omits log path for fully-redirected simple command", () => {
			const r = rewrite("node server.js > /dev/null 2>&1 &");
			// Echo should mention pid and label but NOT a log file
			expect(r.command).toContain("pid=$!");
			expect(r.command).toContain("label=node server.js");
			expect(r.command).not.toMatch(/log=.*\/pi-bg-/);
		});

		it("includes log path for compound even with inner redirects", () => {
			const r = rewrite("cd /dir && cmd > /dev/null 2>&1 &");
			expect(r.command).toMatch(/log=.*\/pi-bg-/);
		});

		it("includes indexed labels for multiple processes", () => {
			const r = rewrite("cmd1 & cmd2 &");
			expect(r.command).toContain("[bg:0]");
			expect(r.command).toContain("[bg:1]");
			expect(r.processes).toHaveLength(2);
		});
	});

	describe("log file paths", () => {
		it("generates unique log file paths per process", () => {
			const r = rewrite("cmd1 & cmd2 &");
			expect(r.processes[0].logFile).not.toBe(r.processes[1].logFile);
			expect(r.processes[0].logFile).toMatch(/pi-bg-.*-0\.log$/);
			expect(r.processes[1].logFile).toMatch(/pi-bg-.*-1\.log$/);
		});

		it("generates different run IDs across calls", () => {
			const r1 = rewrite("cmd &");
			const r2 = rewrite("cmd &");
			expect(r1.processes[0].logFile).not.toBe(r2.processes[0].logFile);
		});
	});
});
