import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectBackground } from "../src/detect.js";
import { type RewriteResult, rewriteCommand } from "../src/rewrite.js";

/**
 * Regression tests for multi-job / grouped / tricky-lexing background commands.
 * Every rewritten script is checked with `bash -n`, and the multi-job cases are
 * actually executed.
 */

const cleanup: string[] = [];
const pids: number[] = [];

afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
	for (const f of cleanup.splice(0)) {
		try {
			rmSync(f, { recursive: true, force: true });
		} catch {}
	}
});

function rewrite(command: string): RewriteResult {
	const { bgStatements } = detectBackground(command);
	const r = rewriteCommand(command, bgStatements);
	for (const p of r.processes) if (p.logFile) cleanup.push(p.logFile);
	return r;
}

function bashSyntaxOk(script: string): void {
	execFileSync("bash", ["-n", "-c", script], { stdio: ["ignore", "pipe", "pipe"] });
}

function run(script: string, timeout = 5000): string {
	const out = execFileSync("bash", ["-c", script], {
		timeout,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (const m of out.matchAll(/\[bg\] pid=(\d+)/g)) pids.push(Number(m[1]));
	return out;
}

function bgLines(out: string): string[] {
	return out.split("\n").filter((l) => l.startsWith("[bg]"));
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
}

function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "bash-bg-test-"));
	cleanup.push(d);
	return d;
}

describe("wait policy: scripts that wait on their jobs run as written", () => {
	it("observed failure: (A | tail) & (B | tail) & wait; ... is left unchanged and works", () => {
		const d = tmpDir();
		const cmd = `(echo A | tail > ${d}/a.txt) & (echo B | tail > ${d}/b.txt) & wait; echo done; cat ${d}/a.txt`;
		const r = rewrite(cmd);
		expect(r.command).toBe(cmd);
		expect(r.processes).toEqual([]);
		expect(run(r.command)).toBe("done\nA\n");
	});

	it("a & b & wait is left unchanged", () => {
		const cmd = "sleep 0.1 & sleep 0.1 & wait";
		expect(rewrite(cmd).command).toBe(cmd);
	});

	it("multi-line with wait later is left unchanged", () => {
		const cmd = "sleep 0.1 &\npid=$!\necho hi\nwait $pid && echo ok";
		expect(rewrite(cmd).command).toBe(cmd);
	});

	for (const cmd of [
		"sleep 0.1 & command wait",
		"sleep 0.1 & builtin wait",
		"sleep 0.1 & if true; then { wait; }; fi",
		"shopt -s lastpipe; set +m; sleep 0.1 & : | wait",
	]) {
		it(`${JSON.stringify(cmd)} is left unchanged (blocks)`, () => {
			expect(rewrite(cmd).command).toBe(cmd);
		});
	}

	it("wait inside a background job doesn't count: both jobs are detached", () => {
		const r = rewrite("sleep 30 & { wait; } &");
		expect(r.processes).toHaveLength(2);
		const t = Date.now();
		expect(bgLines(run(r.command))).toHaveLength(2);
		expect(Date.now() - t).toBeLessThan(2000);
	});

	for (const cmd of ["sleep 30 & (wait)", "sleep 30 & wait | cat", "sleep 30 & : | wait", "sleep 30 & echo $(wait)"]) {
		it(`${JSON.stringify(cmd)}: wait in a subshell can't block, so rewrite`, () => {
			expect(rewrite(cmd).processes).toHaveLength(1);
		});
	}

	it("wait before the & does not block rewriting", () => {
		const r = rewrite("wait; sleep 0.1 &");
		expect(r.processes).toHaveLength(1);
	});
});

describe("multiple jobs", () => {
	it("a & b & (no wait): two jobs, two logs, two [bg] lines with distinct pids", async () => {
		const r = rewrite("echo one & echo two &");
		expect(r.processes).toHaveLength(2);
		bashSyntaxOk(r.command);
		const out = run(r.command);
		const lines = bgLines(out);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("label=echo one");
		expect(lines[1]).toContain("label=echo two");
		const p = lines.map((l) => l.match(/pid=(\d+)/)?.[1]);
		expect(p[0]).not.toBe(p[1]);
		await waitFor(() => r.processes.every((x) => existsSync(x.logFile) && readFileSync(x.logFile, "utf-8").length > 0));
		expect(readFileSync(r.processes[0].logFile, "utf-8")).toBe("one\n");
		expect(readFileSync(r.processes[1].logFile, "utf-8")).toBe("two\n");
	});

	it("observed failure shape without wait: two subshell groups", async () => {
		const r = rewrite("(echo A | tail) & (echo B | tail) & echo fg");
		expect(r.processes).toHaveLength(2);
		bashSyntaxOk(r.command);
		const out = run(r.command);
		expect(bgLines(out)).toHaveLength(2);
		expect(out).toContain("fg\n");
		await waitFor(() => r.processes.every((x) => existsSync(x.logFile) && readFileSync(x.logFile, "utf-8").length > 0));
		expect(readFileSync(r.processes[0].logFile, "utf-8")).toBe("A\n");
		expect(readFileSync(r.processes[1].logFile, "utf-8")).toBe("B\n");
	});

	it("returns immediately even with long-running jobs", () => {
		const r = rewrite("sleep 30 & sleep 30 &\necho after");
		const t = Date.now();
		const out = run(r.command);
		expect(Date.now() - t).toBeLessThan(2000);
		expect(bgLines(out)).toHaveLength(2);
		expect(out).toContain("after");
	});

	it("multi-line script with several jobs", () => {
		const cmd = "echo start\nsleep 30 &\nsleep 30 &\necho end";
		const r = rewrite(cmd);
		expect(r.processes).toHaveLength(2);
		const out = run(r.command);
		expect(out.split("\n").filter(Boolean)[0]).toBe("start");
		expect(bgLines(out)).toHaveLength(2);
		expect(out).toContain("end\n");
	});
});

describe("single job forms (syntax-checked and executed)", () => {
	const cases: [string, string][] = [
		["(echo x) &", "x\n"],
		["{ echo x; } &", "x\n"],
		["true && echo x &", "x\n"],
		["echo x 2>&1 &", "x\n"],
		["nohup echo x &", "x\n"],
		["echo 'a & b' &", "a & b\n"],
		['echo "a & b" &', "a & b\n"],
		["echo $(echo a & wait) &", "a\n"],
		["echo `echo a` &", "a\n"],
		["echo x & # comment with & and wait", "x\n"],
		["echo x & disown", "x\n"],
		["echo x &>/dev/stdout &", "x\n"],
	];
	for (const [cmd, expected] of cases) {
		it(JSON.stringify(cmd), async () => {
			const r = rewrite(cmd);
			expect(r.processes).toHaveLength(1);
			bashSyntaxOk(r.command);
			const out = run(r.command);
			expect(bgLines(out)).toHaveLength(1);
			const log = r.processes[0].logFile;
			if (log) {
				await waitFor(() => existsSync(log) && readFileSync(log, "utf-8").length >= expected.length);
				expect(readFileSync(log, "utf-8")).toBe(expected);
			}
		});
	}

	it("trailing & disown: no duplicate disown", () => {
		const r = rewrite("sleep 30 & disown");
		expect(r.command.match(/disown/g)).toHaveLength(1);
		expect(bgLines(run(r.command))).toHaveLength(1);
	});

	it("nohup label strips wrapper", () => {
		expect(rewrite("nohup sleep 30 &").processes[0].label).toBe("sleep 30");
	});
});

describe("& that is not a background operator is left untouched", () => {
	const untouched = [
		"echo 'a & b'",
		'echo "a & b"',
		"echo $(sleep 0 &)",
		"echo hi # trailing & comment",
		"cat <<EOF\na & b\nEOF",
		"a && b",
		"echo x 2>&1",
		"echo x |& cat",
		"echo x &> /dev/null",
		"( sleep 0 & )",
	];
	for (const cmd of untouched) {
		it(JSON.stringify(cmd), () => {
			expect(rewrite(cmd).command).toBe(cmd);
		});
	}

	it("heredoc body containing & before a real bg job is preserved", () => {
		const cmd = "cat <<EOF\na & b\nEOF\necho x &";
		const r = rewrite(cmd);
		expect(r.processes).toHaveLength(1);
		bashSyntaxOk(r.command);
		const out = run(r.command);
		expect(out.startsWith("a & b\n")).toBe(true);
		expect(bgLines(out)).toHaveLength(1);
	});

	it("bg command with its own heredoc gets the body in its log", async () => {
		const r = rewrite("cat <<EOF &\nhello & bye\nEOF\necho fg");
		expect(r.processes).toHaveLength(1);
		bashSyntaxOk(r.command);
		const out = run(r.command);
		expect(bgLines(out)).toHaveLength(1);
		expect(out).toContain("fg\n");
		const log = r.processes[0].logFile;
		await waitFor(() => existsSync(log) && readFileSync(log, "utf-8").length > 0);
		expect(readFileSync(log, "utf-8")).toBe("hello & bye\n");
	});
});

describe("nested constructs: inner & is not top-level", () => {
	const cases: [string, number][] = [
		["for i in 1 2; do sleep 0 & done; echo x &", 1],
		["if true; then sleep 0 & fi\necho x &", 1],
		["case a in a) sleep 0 & ;; esac; echo x &", 1],
		["f() { sleep 0 & }; f; echo x &", 1],
		["[[ -n a && -n b ]] && echo x &", 1],
		["while false; do :; done & echo y &", 2],
		['echo "${x:-a & b}" &', 1],
		["diff <(echo a &) <(echo b) &", 1],
	];
	for (const [cmd, jobs] of cases) {
		it(JSON.stringify(cmd), () => {
			const r = rewrite(cmd);
			bashSyntaxOk(r.command);
			expect(r.processes).toHaveLength(jobs);
			expect(bgLines(run(r.command))).toHaveLength(jobs);
		});
	}
});

describe("fail safe", () => {
	it("|& pipeline in bg: @aliou/sh (0.3.3) can't parse it, so unchanged", () => {
		const cmd = "echo x |& cat &";
		expect(rewrite(cmd).command).toBe(cmd);
	});

	it("unparseable command is unchanged", () => {
		const cmd = "echo ( &";
		expect(rewrite(cmd).command).toBe(cmd);
	});
});
