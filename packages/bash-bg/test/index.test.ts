import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionHandler,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension, { BASH_BG_SYSTEM_PROMPT_SECTION } from "../src/index.js";

type HandlerMap = Map<string, ExtensionHandler<never>[]>;

function makeFakePi(): { pi: ExtensionAPI; handlers: HandlerMap; tools: ToolDefinition[] } {
	const handlers: HandlerMap = new Map();
	const tools: ToolDefinition[] = [];
	const pi = {
		on(event: string, handler: ExtensionHandler<never>) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools };
}

describe("pi-bash-bg extension", () => {
	it("does not re-register the bash tool (preserves pi's commandPrefix/shellPath/spawnHook)", () => {
		const { pi, tools } = makeFakePi();
		extension(pi);
		expect(tools.find((tool) => tool.name === "bash")).toBeUndefined();
		// The extension must not register any tool; it only hooks events.
		expect(tools).toHaveLength(0);
	});

	it("registers tool_call and before_agent_start handlers", () => {
		const { pi, handlers } = makeFakePi();
		extension(pi);
		expect(handlers.get("tool_call")?.length).toBe(1);
		expect(handlers.get("before_agent_start")?.length).toBe(1);
	});

	it("appends background-job guidance to the system prompt", async () => {
		const { pi, handlers } = makeFakePi();
		extension(pi);
		const handler = handlers.get("before_agent_start")?.[0];
		expect(handler).toBeDefined();

		const event: BeforeAgentStartEvent = {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "You are a coding agent.",
			systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
		};
		const result = await (handler as (e: BeforeAgentStartEvent) => Promise<{ systemPrompt?: string } | undefined>)(
			event,
		);

		expect(result?.systemPrompt).toBeDefined();
		expect(result?.systemPrompt).toContain("You are a coding agent.");
		expect(result?.systemPrompt).toContain(BASH_BG_SYSTEM_PROMPT_SECTION);
		expect(result?.systemPrompt).toContain("`command &`");
		expect(result?.systemPrompt).toContain("[bg] pid=");
	});

	it("does not duplicate the guidance if it is already present", async () => {
		const { pi, handlers } = makeFakePi();
		extension(pi);
		const handler = handlers.get("before_agent_start")?.[0];
		const event: BeforeAgentStartEvent = {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: `You are a coding agent.\n\n${BASH_BG_SYSTEM_PROMPT_SECTION}`,
			systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
		};
		const result = await (handler as (e: BeforeAgentStartEvent) => Promise<{ systemPrompt?: string } | undefined>)(
			event,
		);
		expect(result).toBeUndefined();
	});
});
