import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	dts: true,
	clean: true,
	external: ["@mariozechner/pi-ai", "@mariozechner/pi-coding-agent", "pi-budget-model"],
});
