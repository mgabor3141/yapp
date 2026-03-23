import { describe, expect, it } from "vitest";
import type { ResolvedHostPolicy } from "../src/config.js";
import { checkPolicy, evaluateRequest, matchPath } from "../src/policy.js";

describe("matchPath", () => {
	it("matches literal paths", () => {
		expect(matchPath("/graphql", "/graphql")).toBe(true);
		expect(matchPath("/graphql", "/other")).toBe(false);
	});

	it("matches single-segment wildcard", () => {
		expect(matchPath("/repos/*/issues", "/repos/owner/issues")).toBe(true);
		expect(matchPath("/repos/*/issues", "/repos/owner/repo/issues")).toBe(false);
	});

	it("matches multi-segment wildcard", () => {
		expect(matchPath("/repos/*/*/pulls", "/repos/owner/repo/pulls")).toBe(true);
		expect(matchPath("/repos/*/*/pulls", "/repos/owner/pulls")).toBe(false);
	});

	it("matches ** (rest of path)", () => {
		expect(matchPath("/repos/**", "/repos/owner/repo/pulls/123")).toBe(true);
		expect(matchPath("/repos/**", "/repos")).toBe(true);
		expect(matchPath("/other/**", "/repos/foo")).toBe(false);
	});

	it("handles * as match-all for single segment", () => {
		expect(matchPath("*", "/graphql")).toBe(true);
		expect(matchPath("*", "/repos/foo")).toBe(false);
	});

	it("/** matches the root path", () => {
		expect(matchPath("/**", "/")).toBe(true);
		expect(matchPath("/**", "")).toBe(true);
	});

	it("normalizes leading slash", () => {
		expect(matchPath("graphql", "/graphql")).toBe(true);
		expect(matchPath("/graphql", "graphql")).toBe(true);
	});
});

describe("checkPolicy", () => {
	const policy: ResolvedHostPolicy = {
		hostname: "api.github.com",
		allows: new Map([
			["GET", ["*"]],
			["POST", ["/repos/*/*/pulls"]],
		]),
		deny: ["/repos/*/*/pulls/*/merge", "/repos/*/*/branches/*/protection"],
		unmatched: "prompt",
	};

	it("allows matching GET requests", () => {
		expect(checkPolicy(policy, "GET", "/repos")).toBe("allow");
		expect(checkPolicy(policy, "GET", "/user")).toBe("allow");
	});

	it("allows matching POST requests", () => {
		expect(checkPolicy(policy, "POST", "/repos/owner/repo/pulls")).toBe("allow");
	});

	it("denies matching deny patterns (overrides allows)", () => {
		expect(checkPolicy(policy, "POST", "/repos/owner/repo/pulls/1/merge")).toBe("deny");
		expect(checkPolicy(policy, "GET", "/repos/owner/repo/branches/main/protection")).toBe("deny");
	});

	it("returns unmatched policy for non-matching requests", () => {
		expect(checkPolicy(policy, "DELETE", "/repos/owner/repo")).toBe("prompt");
		expect(checkPolicy(policy, "POST", "/repos/owner/repo/issues")).toBe("prompt");
	});

	it("is case-insensitive for method", () => {
		expect(checkPolicy(policy, "get", "/user")).toBe("allow");
	});
});

describe("evaluateRequest", () => {
	it("allows requests when no policy exists for the host", () => {
		const policies = new Map<string, ResolvedHostPolicy>();
		expect(evaluateRequest(policies, "example.com", "GET", "/")).toBe("allow");
	});

	it("checks policy when one exists", () => {
		const policies = new Map<string, ResolvedHostPolicy>([
			[
				"api.github.com",
				{
					hostname: "api.github.com",
					allows: new Map([["GET", ["*"]]]),
					deny: [],
					unmatched: "deny",
				},
			],
		]);

		expect(evaluateRequest(policies, "api.github.com", "GET", "/repos")).toBe("allow");
		expect(evaluateRequest(policies, "api.github.com", "POST", "/repos")).toBe("deny");
		expect(evaluateRequest(policies, "other.com", "POST", "/anything")).toBe("allow");
	});
});
