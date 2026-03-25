import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	dts: true,
	clean: true,
	external: ["@mariozechner/pi-coding-agent", "@earendil-works/gondolin"],
	onSuccess: async () => {
		// Copy the ESM loader hooks file to dist (plain JS, not processed by tsup)
		cpSync("src/fs-loader-hooks.mjs", "dist/fs-loader-hooks.mjs");
	},
});
