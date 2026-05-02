#!/usr/bin/env node
/**
 * Verify that every affected publishable package in this PR has at least
 * one new changeset entry.
 *
 * "Affected" = a release-worthy file under `packages/<pkg>/` was added,
 * modified, renamed, or deleted in the PR diff. Tests, build/test config,
 * and CHANGELOG.md are excluded since they don't ship to consumers.
 *
 * "Covered" = a `.changeset/*.md` file added in this PR has a frontmatter
 * entry naming the package (any bump level).
 *
 * Exits 0 on success, 1 if any affected package is missing a changeset,
 * 2 on usage/setup error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA || "HEAD";
if (!baseSha) {
	console.error("BASE_SHA env var is required");
	process.exit(2);
}

// All git calls go through execFileSync (no shell) so paths returned by
// `git diff` cannot be interpreted as shell metacharacters. The workflow
// always runs `actions/checkout@v4` with `fetch-depth: 0`, so both base
// and head SHAs are reachable; no fallback fetch is needed.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const diffRange = `${baseSha}...${headSha}`;
const changedFiles = git("diff", "--name-only", "--diff-filter=ACMRTD", diffRange).split("\n").filter(Boolean);

// Discover publishable workspace packages.
const packagesDir = "packages";
const pkgNameByDir = new Map();
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const pjPath = join(packagesDir, entry.name, "package.json");
	if (!existsSync(pjPath)) continue;
	const pj = JSON.parse(readFileSync(pjPath, "utf8"));
	if (pj.private || !pj.name) continue;
	pkgNameByDir.set(entry.name, pj.name);
}

/** Return the package name if `file` is release-worthy, else null. */
function packageForFile(file) {
	const m = file.match(/^packages\/([^/]+)\/(.+)$/);
	if (!m) return null;
	const [, dir, rest] = m;
	const name = pkgNameByDir.get(dir);
	if (!name) return null;
	// Excluded: tests, build/test config, generated CHANGELOG.
	if (/(^|\/)(test|tests|__tests__)\//.test(rest)) return null;
	if (/\.(test|spec)\.[jt]sx?$/.test(rest)) return null;
	if (/^(tsup\.config|vitest\.config|tsconfig|biome)\b/.test(rest)) return null;
	if (rest === "CHANGELOG.md") return null;
	return name;
}

const affected = new Set();
for (const f of changedFiles) {
	const name = packageForFile(f);
	if (name) affected.add(name);
}

// Collect packages covered by changeset files added or modified in this PR.
// We allow `M` so a PR that amends an earlier changeset on the same branch
// (e.g. to add another package) is still recognised.
const addedChangesetFiles = git("diff", "--name-only", "--diff-filter=AM", diffRange, "--", ".changeset/*.md")
	.split("\n")
	.filter(Boolean)
	.filter((f) => !f.endsWith("README.md"));

const covered = new Set();
for (const file of addedChangesetFiles) {
	// Read from the head ref so the script works even if the file has
	// already been consumed by a later `changeset version` run.
	const text = git("show", `${headSha}:${file}`);
	const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!fm) continue;
	for (const line of fm[1].split("\n")) {
		// Match `"@scope/name": patch` or `name: minor` etc.
		const m = line.match(/^\s*["']?([^"'\s:]+)["']?\s*:\s*(patch|minor|major)\s*$/);
		if (m) covered.add(m[1]);
	}
}

const missing = [...affected].filter((p) => !covered.has(p)).sort();

if (affected.size === 0) {
	console.log("No publishable package files changed; no changeset required.");
	process.exit(0);
}

console.log(`Affected packages (${affected.size}): ${[...affected].sort().join(", ")}`);
console.log(`Covered by new changesets (${covered.size}): ${[...covered].sort().join(", ") || "(none)"}`);

if (missing.length === 0) {
	console.log("✓ All affected packages have a changeset.");
	process.exit(0);
}

console.error("");
console.error("✗ Missing changeset entries for:");
for (const p of missing) console.error(`  - ${p}`);
console.error("");
console.error("Run `yarn changeset` locally, select the affected packages, and commit");
console.error("the resulting file under .changeset/. If a change genuinely needs no");
console.error("release (e.g. internal refactor with no observable effect), add a patch");
console.error("changeset whose summary explains why.");
process.exit(1);
