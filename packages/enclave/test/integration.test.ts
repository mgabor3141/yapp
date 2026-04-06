/**
 * Integration tests for config loading, file creation, and package management.
 * Uses a temp directory to avoid touching real config files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addPackageToConfig,
	collectConfigFiles,
	ensureGlobalConfig,
	globalConfigPath,
	globalDropInDir,
	initProjectConfig,
	loadConfig,
	mergeConfigs,
} from "../src/config.js";

// Override HOME so we don't touch real config
let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	tmpDir = join(import.meta.dirname ?? ".", `.test-tmp-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env.HOME = tmpDir;
});

afterEach(() => {
	process.env.HOME = origHome;
	// Clean up
	const { rmSync } = require("node:fs");
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("ensureGlobalConfig", () => {
	it("creates main config and drop-in files", () => {
		const created = ensureGlobalConfig();
		expect(created.length).toBeGreaterThan(0);
		expect(existsSync(globalConfigPath())).toBe(true);
		expect(existsSync(join(globalDropInDir(), "git.toml"))).toBe(true);
		expect(existsSync(join(globalDropInDir(), "jj.toml"))).toBe(true);
		expect(existsSync(join(globalDropInDir(), "github.toml"))).toBe(true);
	});

	it("does not overwrite existing files", () => {
		ensureGlobalConfig();
		// Modify the config
		const configPath = globalConfigPath();
		writeFileSync(configPath, 'packages = ["custom"]\n');
		// Run again
		const created = ensureGlobalConfig();
		expect(created).toEqual([]);
		expect(readFileSync(configPath, "utf-8")).toContain("custom");
	});
});

describe("initProjectConfig", () => {
	it("creates project config from template", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(projectDir, { recursive: true });
		const result = initProjectConfig(projectDir);
		expect(result).toBe(true);
		const content = readFileSync(join(projectDir, ".pi", "enclave.toml"), "utf-8");
		expect(content).toContain("enabled = true");
	});

	it("does not overwrite existing project config", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), "enabled = false\n");
		const result = initProjectConfig(projectDir);
		expect(result).toBe(false);
	});
});

describe("collectConfigFiles with drop-ins", () => {
	it("loads global config and drop-in files", () => {
		ensureGlobalConfig();
		const layers = collectConfigFiles(tmpDir);
		// Global + git.toml + github.toml + jj.toml (alphabetical)
		expect(layers.length).toBeGreaterThanOrEqual(4);
		const paths = layers.map((l) => l.path);
		expect(paths[0]).toBe(globalConfigPath());
		// Drop-ins are alphabetical
		expect(paths[1]).toContain("git.toml");
		expect(paths[2]).toContain("github.toml");
		expect(paths[3]).toContain("jj.toml");
	});

	it("merges packages from all layers additively", () => {
		ensureGlobalConfig();
		const { merged } = loadConfig(tmpDir);
		const pkgs = merged.packages ?? [];
		expect(pkgs).toContain("curl");
		expect(pkgs).toContain("jq");
		expect(pkgs).toContain("git");
		expect(pkgs).toContain("jujutsu");
		expect(pkgs).toContain("github-cli");
	});

	it("collects setup scripts from drop-ins", () => {
		ensureGlobalConfig();
		const { merged } = loadConfig(tmpDir);
		expect(merged.setup).toContain("safe.directory");
		expect(merged.setup).toContain("jj config set");
	});

	it("reports config sources accurately", () => {
		ensureGlobalConfig();
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), "enabled = true\n");

		const result = loadConfig(projectDir);
		expect(result.hasGlobalConfig).toBe(true);
		expect(result.hasProjectConfig).toBe(true);
		expect(result.dropIns).toEqual(["git", "github", "jj"]);
	});

	it("uses the last configured image", () => {
		ensureGlobalConfig();
		writeFileSync(globalConfigPath(), 'image = "global:latest"\n');
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), 'enabled = true\nimage = "project:latest"\n');

		const { merged } = loadConfig(projectDir);
		expect(merged.image).toBe("project:latest");
	});

	it("does not walk ancestor directories", () => {
		ensureGlobalConfig();
		const parent = join(tmpDir, "parent");
		const child = join(parent, "child");
		mkdirSync(join(parent, ".pi"), { recursive: true });
		mkdirSync(child, { recursive: true });
		writeFileSync(join(parent, ".pi", "enclave.toml"), "enabled = true\n");

		const result = loadConfig(child);
		// Parent config should NOT be picked up
		expect(result.hasProjectConfig).toBe(false);
		expect(result.merged.enabled).toBeUndefined();
	});
});

describe("addPackageToConfig", () => {
	it("adds a package to an existing config", () => {
		ensureGlobalConfig();
		addPackageToConfig(tmpDir, "ripgrep", "global");
		const content = readFileSync(globalConfigPath(), "utf-8");
		expect(content).toContain("ripgrep");
		expect(content).toContain("curl"); // original packages preserved
	});

	it("does not duplicate existing packages", () => {
		ensureGlobalConfig();
		addPackageToConfig(tmpDir, "curl", "global");
		const content = readFileSync(globalConfigPath(), "utf-8");
		const matches = content.match(/curl/g);
		expect(matches).toHaveLength(1);
	});

	it("does not seed project config with hardcoded packages", () => {
		const projectDir = join(tmpDir, "project");
		addPackageToConfig(projectDir, "ripgrep", "project");
		const content = readFileSync(join(projectDir, ".pi", "enclave.toml"), "utf-8");
		expect(content).toContain('packages = ["ripgrep"]');
		expect(content).not.toContain("curl");
		expect(content).not.toContain("jq");
		expect(content).not.toContain("git");
	});
});

describe("mount path resolution", () => {
	it("expands ~ to HOME in mount paths", () => {
		ensureGlobalConfig();
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), 'enabled = true\n\n[[mounts]]\npath = "~/dev/.jj"\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "dev/.jj"));
	});

	it("expands ~ in bare string mounts", () => {
		ensureGlobalConfig();
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), 'enabled = true\nmounts = ["~/dev/.jj", "~/dev/.git"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts).toHaveLength(2);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "dev/.jj"));
		expect(merged.mounts?.[1]?.path).toBe(join(tmpDir, "dev/.git"));
	});

	it("resolves relative paths against cwd", () => {
		const projectDir = join(tmpDir, "project", "sub");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), 'enabled = true\nmounts = ["../.jj", "../.git"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts).toHaveLength(2);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "project", ".jj"));
		expect(merged.mounts?.[1]?.path).toBe(join(tmpDir, "project", ".git"));
	});

	it("resolves nested relative paths against cwd", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), 'enabled = true\nmounts = ["../shared/data"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "shared/data"));
	});

	it("leaves absolute paths unchanged", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "enclave.toml"), 'enabled = true\nmounts = ["/tmp/shared"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe("/tmp/shared");
	});

	it("resolves relative paths in object mount syntax", () => {
		const projectDir = join(tmpDir, "project", "sub");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "enclave.toml"),
			'enabled = true\n\n[[mounts]]\npath = "../.jj"\nreadonly = true\n',
		);
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "project", ".jj"));
		expect(merged.mounts?.[0]?.readonly).toBe(true);
	});
});
