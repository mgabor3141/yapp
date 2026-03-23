import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { DEFAULT_PACKAGES, EnclaveFileConfig, mergeConfigs, resolveHostPolicies } from "../src/config.js";

describe("EnclaveFileConfig schema", () => {
	it("accepts empty config", () => {
		const result = v.parse(EnclaveFileConfig, {});
		expect(result.enabled).toBeUndefined();
		expect(result.packages).toBeUndefined();
		expect(result.secrets).toEqual({});
		expect(result.hosts).toEqual({});
	});

	it("accepts enabled = true", () => {
		const result = v.parse(EnclaveFileConfig, { enabled: true });
		expect(result.enabled).toBe(true);
	});

	it("accepts enabled = false", () => {
		const result = v.parse(EnclaveFileConfig, { enabled: false });
		expect(result.enabled).toBe(false);
	});

	it("accepts full config", () => {
		const result = v.parse(EnclaveFileConfig, {
			enabled: true,
			packages: ["git", "curl", "ripgrep"],
			secrets: {
				GH_TOKEN: { command: "gh auth token", hosts: ["api.github.com"] },
				OPENAI_API_KEY: { env: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
			},
			hosts: {
				"api.github.com": {
					allow: { GET: ["/**"] },
					deny: ["/repos/*/*/pulls/*/merge"],
					unmatched: "prompt",
					graphql: {
						endpoint: "/graphql",
						allow: { query: ["*"], mutation: ["createPullRequest"] },
					},
				},
			},
		});

		expect(result.packages).toEqual(["git", "curl", "ripgrep"]);
		expect(result.secrets?.GH_TOKEN).toEqual({
			command: "gh auth token",
			hosts: ["api.github.com"],
		});
		const host = result.hosts?.["api.github.com"];
		expect(host?.deny).toEqual(["/repos/*/*/pulls/*/merge"]);
		expect(host?.unmatched).toBe("prompt");
		expect(host?.graphql?.endpoint).toBe("/graphql");
		expect(host?.graphql?.allow.mutation).toEqual(["createPullRequest"]);
	});

	it("accepts false to disable a secret", () => {
		const result = v.parse(EnclaveFileConfig, {
			secrets: { GH_TOKEN: false },
		});
		expect(result.secrets?.GH_TOKEN).toBe(false);
	});

	it("accepts host with just secret reference", () => {
		const result = v.parse(EnclaveFileConfig, {
			hosts: { "github.com": { secret: "GH_TOKEN" } },
		});
		expect(result.hosts?.["github.com"]?.secret).toBe("GH_TOKEN");
	});

	it("rejects invalid unmatched value", () => {
		expect(() =>
			v.parse(EnclaveFileConfig, {
				hosts: {
					"example.com": { unmatched: "maybe" },
				},
			}),
		).toThrow();
	});
});

describe("mergeConfigs", () => {
	it("returns defaults with empty layers", () => {
		const result = mergeConfigs([]);
		expect(result.packages).toEqual([]);
		expect(result.secrets).toEqual({});
		expect(result.hosts).toEqual({});
	});

	it("later enabled wins", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, { enabled: false }),
			v.parse(EnclaveFileConfig, { enabled: true }),
		]);
		expect(result.enabled).toBe(true);
	});

	it("enabled stays undefined when not set", () => {
		const result = mergeConfigs([v.parse(EnclaveFileConfig, {})]);
		expect(result.enabled).toBeUndefined();
	});

	it("packages accumulate across layers, deduplicated", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, { packages: ["git", "curl"] }),
			v.parse(EnclaveFileConfig, { packages: ["git", "ripgrep"] }),
		]);
		expect(result.packages).toEqual(["git", "curl", "ripgrep"]);
	});

	it("secrets merge by key, later wins", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, {
				secrets: {
					GH_TOKEN: { command: "old-cmd", hosts: ["github.com"] },
					OTHER: { env: "OTHER", hosts: ["other.com"] },
				},
			}),
			v.parse(EnclaveFileConfig, {
				secrets: {
					GH_TOKEN: { command: "new-cmd", hosts: ["api.github.com"] },
				},
			}),
		]);

		expect(result.secrets?.GH_TOKEN).toEqual({
			command: "new-cmd",
			hosts: ["api.github.com"],
		});
		expect(result.secrets?.OTHER).toEqual({ env: "OTHER", hosts: ["other.com"] });
	});

	it("false disables a secret from earlier layer", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, {
				secrets: { GH_TOKEN: { command: "gh auth token", hosts: ["github.com"] } },
			}),
			v.parse(EnclaveFileConfig, {
				secrets: { GH_TOKEN: false },
			}),
		]);
		expect(result.secrets?.GH_TOKEN).toBe(false);
	});

	it("mounts accumulate across layers, later wins on same path", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, {
				mounts: [{ path: "/home/user/.jj", readonly: false }],
			}),
			v.parse(EnclaveFileConfig, {
				mounts: [{ path: "/home/user/.jj", readonly: true }, { path: "/home/user/other" }],
			}),
		]);
		expect(result.mounts).toHaveLength(2);
		expect(result.mounts).toContainEqual({ path: "/home/user/.jj", readonly: true });
		expect(result.mounts).toContainEqual({ path: "/home/user/other", readonly: false });
	});

	it("env merges by key, later wins", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, {
				env: { USER_NAME: "Alice", EDITOR: "vim" },
			}),
			v.parse(EnclaveFileConfig, {
				env: { USER_NAME: { command: "whoami" } },
			}),
		]);
		expect(result.env?.USER_NAME).toEqual({ command: "whoami" });
		expect(result.env?.EDITOR).toBe("vim");
	});

	it("setup scripts concatenate across layers", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, { setup: "echo git" }),
			v.parse(EnclaveFileConfig, {}),
			v.parse(EnclaveFileConfig, { setup: "echo jj" }),
		]);
		expect(result.setup).toBe("echo git\necho jj");
	});

	it("hosts merge by key, later wins", () => {
		const result = mergeConfigs([
			v.parse(EnclaveFileConfig, {
				hosts: { "api.github.com": { unmatched: "prompt", allow: { GET: ["/**"] } } },
			}),
			v.parse(EnclaveFileConfig, {
				hosts: { "api.github.com": { unmatched: "allow" } },
			}),
		]);
		expect(result.hosts?.["api.github.com"]?.unmatched).toBe("allow");
	});
});

describe("resolveHostPolicies", () => {
	it("resolves host policies from config", () => {
		const config = v.parse(EnclaveFileConfig, {
			hosts: {
				"api.github.com": {
					allow: { GET: ["/repos/**"] },
					deny: ["/admin/**"],
					unmatched: "prompt",
				},
			},
		});

		const policies = resolveHostPolicies(config);
		const policy = policies.get("api.github.com");

		expect(policy).toBeDefined();
		expect(policy!.hostname).toBe("api.github.com");
		expect(policy!.allows.get("GET")).toEqual(["/repos/**"]);
		expect(policy!.deny).toEqual(["/admin/**"]);
		expect(policy!.unmatched).toBe("prompt");
	});

	it("uppercases method names", () => {
		const config = v.parse(EnclaveFileConfig, {
			hosts: {
				"example.com": {
					allow: { get: ["/foo"], post: ["/bar"] },
				},
			},
		});

		const policies = resolveHostPolicies(config);
		const policy = policies.get("example.com")!;
		expect(policy.allows.has("GET")).toBe(true);
		expect(policy.allows.has("POST")).toBe(true);
	});

	it("resolves graphql policy", () => {
		const config = v.parse(EnclaveFileConfig, {
			hosts: {
				"api.github.com": {
					unmatched: "prompt",
					graphql: {
						endpoint: "/graphql",
						allow: { query: ["*"], mutation: ["createPullRequest"] },
					},
				},
			},
		});

		const policies = resolveHostPolicies(config);
		const policy = policies.get("api.github.com")!;
		expect(policy.graphql).toBeDefined();
		expect(policy.graphql!.endpoint).toBe("/graphql");
		expect(policy.graphql!.allow.query).toEqual(["*"]);
		expect(policy.graphql!.allow.mutation).toEqual(["createPullRequest"]);
	});

	it("graphql inherits host unmatched", () => {
		const config = v.parse(EnclaveFileConfig, {
			hosts: {
				"api.github.com": {
					unmatched: "deny",
					graphql: {
						endpoint: "/graphql",
						allow: { query: ["*"] },
					},
				},
			},
		});

		const policies = resolveHostPolicies(config);
		expect(policies.get("api.github.com")!.graphql!.unmatched).toBe("deny");
	});

	it("graphql can override host unmatched", () => {
		const config = v.parse(EnclaveFileConfig, {
			hosts: {
				"api.github.com": {
					unmatched: "deny",
					graphql: {
						endpoint: "/graphql",
						allow: { query: ["*"] },
						unmatched: "prompt",
					},
				},
			},
		});

		const policies = resolveHostPolicies(config);
		expect(policies.get("api.github.com")!.graphql!.unmatched).toBe("prompt");
	});

	it("defaults host unmatched to allow", () => {
		const config = v.parse(EnclaveFileConfig, {
			hosts: { "example.com": {} },
		});

		const policies = resolveHostPolicies(config);
		expect(policies.get("example.com")!.unmatched).toBe("allow");
	});
});

describe("DEFAULT_PACKAGES", () => {
	it("includes git, curl, jq", () => {
		expect(DEFAULT_PACKAGES).toContain("git");
		expect(DEFAULT_PACKAGES).toContain("curl");
		expect(DEFAULT_PACKAGES).toContain("jq");
	});
});
