import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

describe("pi-bash-bg extension", () => {
	it("appends background job guidance to the bash tool description", () => {
		const tools: ToolDefinition[] = [];
		const pi = {
			registerTool(tool) {
				tools.push(tool);
			},
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		extension(pi);

		const bashTool = tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeDefined();
		expect(bashTool?.description).toContain("Background jobs continue running after the command returns.");
		expect(bashTool?.description).toContain(
			"Their output is captured to a log file even without explicit redirection.",
		);
		expect(bashTool?.description).toContain("The PID and log path will be returned.");
	});
});
