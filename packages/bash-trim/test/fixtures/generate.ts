/**
 * Generate test fixture files. Run with: npx tsx test/fixtures/generate.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

// 1. Minified JS — one super-long line
const minified = `!function(e){${Array.from({ length: 200 }, (_, i) => `var v${i}="${"x".repeat(20)}";e.f${i}=function(){return v${i}}`).join(";")}}(window);`;
writeFileSync(join(dir, "minified.js"), minified);

// 2. Normal source file — ~300 lines, reasonable width
const source = Array.from({ length: 300 }, (_, i) => {
	if (i % 20 === 0) return `\n// Section ${Math.floor(i / 20) + 1}`;
	if (i % 5 === 0) return `export function fn_${i}(arg: string): boolean {`;
	if (i % 5 === 1) return "    const result = arg.trim().toLowerCase();";
	if (i % 5 === 2) return `    console.log(\`Processing item \${${i}}: \${result}\`);`;
	if (i % 5 === 3) return "    return result.length > 0;";
	return "}";
}).join("\n");
writeFileSync(join(dir, "source-300.ts"), source);

// 3. Long source file — ~800 lines, reasonable width (legit big file)
const longSource = Array.from({ length: 800 }, (_, i) => {
	if (i % 30 === 0) return `\n// ── Section ${Math.floor(i / 30) + 1} ${"─".repeat(60)}`;
	if (i % 10 === 0) return `export class Handler${i} {`;
	if (i % 10 === 1) return "    private state: Map<string, unknown> = new Map();";
	if (i % 10 === 2) return "    constructor(private readonly name: string) {}";
	if (i % 10 === 3) return "    async process(input: string): Promise<string> {";
	if (i % 10 === 4) return "        const key = `${this.name}:${input}`;";
	if (i % 10 === 5) return "        if (this.state.has(key)) return this.state.get(key) as string;";
	if (i % 10 === 6) return "        const result = await this.transform(input);";
	if (i % 10 === 7) return "        this.state.set(key, result);";
	if (i % 10 === 8) return "        return result;";
	return "    }\n}";
}).join("\n");
writeFileSync(join(dir, "source-800.ts"), longSource);

// 4. Log file — many short lines
const log = Array.from({ length: 1000 }, (_, i) => {
	const ts = `2025-03-06T12:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}Z`;
	return `${ts} [INFO] Request ${i} processed in ${Math.floor(Math.random() * 100)}ms`;
}).join("\n");
writeFileSync(join(dir, "log-1000.txt"), log);

// 5. Wide log — each line has a huge JSON payload
const wideLog = Array.from({ length: 200 }, (_, i) => {
	const payload = JSON.stringify({
		id: i,
		data: "x".repeat(400),
		metadata: { tags: Array.from({ length: 10 }, (_, j) => `tag-${j}`), nested: { deep: { value: i * 100 } } },
	});
	return `[${i}] ${payload}`;
}).join("\n");
writeFileSync(join(dir, "wide-log.txt"), wideLog);

// 6. seq output — many very short lines
const seq = Array.from({ length: 2000 }, (_, i) => String(i + 1)).join("\n");
writeFileSync(join(dir, "seq-2000.txt"), seq);

// 7. npm ls output — moderate width, many lines
const npmLs = Array.from({ length: 500 }, (_, i) => {
	const depth = Math.floor(Math.random() * 5);
	const indent = "│   ".repeat(depth) + (Math.random() > 0.3 ? "├── " : "└── ");
	return `${indent}@scope/package-${i}@${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 20)}.${Math.floor(Math.random() * 30)}`;
}).join("\n");
writeFileSync(join(dir, "npm-ls.txt"), npmLs);

// Report sizes
import { readFileSync } from "node:fs";
for (const name of [
	"minified.js",
	"source-300.ts",
	"source-800.ts",
	"log-1000.txt",
	"wide-log.txt",
	"seq-2000.txt",
	"npm-ls.txt",
]) {
	const content = readFileSync(join(dir, name), "utf-8");
	const lines = content.split("\n");
	const maxWidth = Math.max(...lines.map((l: string) => l.length));
	console.log(`${name}: ${lines.length} lines, ${content.length} chars, max line width: ${maxWidth}`);
}
