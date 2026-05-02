import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: unknown,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

function loadExtension() {
	const tools: ToolDefinition[] = [];
	let toolCallHandler: ToolCallHandler | undefined;
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			tools.push(tool);
		}),
		on: vi.fn((event: string, handler: ToolCallHandler) => {
			if (event === "tool_call") toolCallHandler = handler;
		}),
	} as unknown as ExtensionAPI;

	extension(pi);

	return { pi, tools, toolCallHandler };
}

describe("pi-bash-bg extension", () => {
	it("does not override the built-in bash tool", () => {
		// Replacing the built-in bash tool would force a fixed cwd captured at
		// extension load time, which breaks the cwd of resumed sessions.
		const { pi, tools } = loadExtension();
		expect(tools).toHaveLength(0);
		expect(pi.registerTool).not.toHaveBeenCalled();
	});

	it("registers a tool_call handler", () => {
		const { pi, toolCallHandler } = loadExtension();
		expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
		expect(toolCallHandler).toBeDefined();
	});

	it("rewrites bash commands that contain background statements", async () => {
		const { toolCallHandler } = loadExtension();
		const event: ToolCallEvent = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "id",
			input: { command: "sleep 300 &" },
		};

		await toolCallHandler!(event, {});

		const rewritten = (event.input as { command: string }).command;
		expect(rewritten).not.toBe("sleep 300 &");
		expect(rewritten).toContain("disown");
		expect(rewritten).toContain("[bg]");
	});

	it("leaves non-background bash commands untouched", async () => {
		const { toolCallHandler } = loadExtension();
		const event: ToolCallEvent = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "id",
			input: { command: "echo hi && ls" },
		};

		await toolCallHandler!(event, {});

		expect((event.input as { command: string }).command).toBe("echo hi && ls");
	});

	it("ignores non-bash tool calls", async () => {
		const { toolCallHandler } = loadExtension();
		const event: ToolCallEvent = {
			type: "tool_call",
			toolName: "read",
			toolCallId: "id",
			input: { path: "foo &" },
		};

		await toolCallHandler!(event, {});

		expect((event.input as { path: string }).path).toBe("foo &");
	});
});
