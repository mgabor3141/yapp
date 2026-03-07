import { defineConfig } from "vitest/config";

export default defineConfig({
	cacheDir: ".vitest",
	test: {
		include: ["packages/*/test/**/*.test.ts"],
	},
});
