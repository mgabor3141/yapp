import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEnv, resolveSecrets } from "../src/secrets.js";

// Mock child_process to avoid actually running commands
vi.mock("node:child_process", () => ({
	execSync: vi.fn((cmd: string) => {
		if (cmd === "which gh") return "/usr/bin/gh\n";
		if (cmd === "gh auth token") return "gho_fake_token_12345\n";
		if (cmd === "which npm") throw new Error("not found");
		throw new Error(`command not found: ${cmd}`);
	}),
}));

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("resolveSecrets", () => {
	it("returns empty with no config", () => {
		const secrets = resolveSecrets({});
		expect(secrets).toHaveLength(0);
	});

	it("resolves command-sourced secrets", () => {
		const secrets = resolveSecrets({
			GH_TOKEN: { command: "gh auth token", hosts: ["api.github.com"] },
		});
		expect(secrets).toHaveLength(1);
		expect(secrets[0].name).toBe("GH_TOKEN");
		expect(secrets[0].value).toBe("gho_fake_token_12345");
		expect(secrets[0].hosts).toEqual(["api.github.com"]);
	});

	it("skips command secrets when binary is not found", () => {
		const secrets = resolveSecrets({
			NPM_TOKEN: { command: "npm config get token", hosts: ["registry.npmjs.org"] },
		});
		expect(secrets).toHaveLength(0);
	});

	it("resolves env-sourced secrets", () => {
		process.env.TEST_SECRET = "secret_value";
		try {
			const secrets = resolveSecrets({
				TEST_SECRET: { env: "TEST_SECRET", hosts: ["api.example.com"] },
			});
			expect(secrets).toHaveLength(1);
			expect(secrets[0].value).toBe("secret_value");
			expect(secrets[0].hosts).toEqual(["api.example.com"]);
		} finally {
			// biome-ignore lint/performance/noDelete: process.env needs delete to truly unset
			delete process.env.TEST_SECRET;
		}
	});

	it("skips env secrets when env var is not set", () => {
		// biome-ignore lint/performance/noDelete: process.env needs delete to truly unset
		delete process.env.MISSING_VAR;
		const secrets = resolveSecrets({
			MISSING: { env: "MISSING_VAR", hosts: ["example.com"] },
		});
		expect(secrets).toHaveLength(0);
	});

	it("skips false entries", () => {
		const secrets = resolveSecrets({
			GH_TOKEN: false,
		});
		expect(secrets).toHaveLength(0);
	});

	it("resolves multiple secrets", () => {
		process.env.OPENAI_KEY = "sk-test";
		try {
			const secrets = resolveSecrets({
				GH_TOKEN: { command: "gh auth token", hosts: ["api.github.com"] },
				OPENAI_KEY: { env: "OPENAI_KEY", hosts: ["api.openai.com"] },
			});
			expect(secrets).toHaveLength(2);
		} finally {
			// biome-ignore lint/performance/noDelete: process.env needs delete to truly unset
			delete process.env.OPENAI_KEY;
		}
	});
});

describe("resolveEnv", () => {
	it("resolves static string values", () => {
		const env = resolveEnv({ EDITOR: "vim", LANG: "en_US.UTF-8" });
		expect(env).toEqual({ EDITOR: "vim", LANG: "en_US.UTF-8" });
	});

	it("resolves command sources", () => {
		const env = resolveEnv({ USER_NAME: { command: "gh auth token" } });
		expect(env.USER_NAME).toBe("gho_fake_token_12345");
	});

	it("skips command sources when binary is missing", () => {
		const env = resolveEnv({ TOKEN: { command: "npm config get token" } });
		expect(env.TOKEN).toBeUndefined();
	});

	it("resolves env sources", () => {
		process.env.TEST_VAR = "hello";
		try {
			const env = resolveEnv({ GREETING: { env: "TEST_VAR" } });
			expect(env.GREETING).toBe("hello");
		} finally {
			// biome-ignore lint/performance/noDelete: process.env needs delete to truly unset
			delete process.env.TEST_VAR;
		}
	});

	it("skips missing env sources", () => {
		const env = resolveEnv({ MISSING: { env: "NONEXISTENT_VAR" } });
		expect(env.MISSING).toBeUndefined();
	});
});
