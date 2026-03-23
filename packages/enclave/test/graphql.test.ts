import { describe, expect, it } from "vitest";
import { checkGraphQLPolicy, parseGraphQLBody } from "../src/graphql.js";

describe("parseGraphQLBody", () => {
	it("parses a simple query", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: 'query GetRepo { repository(owner: "x", name: "y") { id } }',
			}),
		);
		expect(ops).toHaveLength(1);
		expect(ops![0].type).toBe("query");
		expect(ops![0].name).toBe("GetRepo");
		expect(ops![0].fields).toEqual(["repository"]);
	});

	it("parses a mutation with multiple fields", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: `mutation DoStuff {
				createPullRequest(input: $i) { pullRequest { id } }
				addComment(input: $c) { comment { id } }
			}`,
			}),
		);
		expect(ops).toHaveLength(1);
		expect(ops![0].type).toBe("mutation");
		expect(ops![0].fields).toEqual(["createPullRequest", "addComment"]);
	});

	it("parses multiple operations", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: `
				query ReadStuff { repository { id } }
				mutation WriteStuff { createIssue(input: $i) { issue { id } } }
			`,
			}),
		);
		expect(ops).toHaveLength(2);
		expect(ops![0].type).toBe("query");
		expect(ops![1].type).toBe("mutation");
	});

	it("handles anonymous queries", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "{ repository { id } }",
			}),
		);
		expect(ops).toHaveLength(1);
		expect(ops![0].type).toBe("query");
		expect(ops![0].name).toBeUndefined();
	});

	it("returns undefined for invalid JSON", () => {
		expect(parseGraphQLBody("not json")).toBeUndefined();
	});

	it("returns undefined for invalid GraphQL", () => {
		expect(parseGraphQLBody(JSON.stringify({ query: "not graphql {{{}}" }))).toBeUndefined();
	});

	it("returns undefined when query field is missing", () => {
		expect(parseGraphQLBody(JSON.stringify({ variables: {} }))).toBeUndefined();
	});
});

describe("checkGraphQLPolicy", () => {
	it("allows all queries with query: ['*']", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "query GetRepo { repository { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: ["*"], mutation: [] });
		expect(result.allowed).toBe(true);
	});

	it("allows specific mutation fields", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation X { createPullRequest(input: $i) { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: ["*"], mutation: ["createPullRequest"] });
		expect(result.allowed).toBe(true);
	});

	it("denies mutation fields not in the allow list", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation X { deleteBranchProtectionRule(input: $i) { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: ["*"], mutation: ["createPullRequest"] });
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.deniedFields).toEqual(["deleteBranchProtectionRule"]);
		}
	});

	it("catches spoofed operation names", () => {
		// Operation is named CreatePullRequest but actually deletes branch protection
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation CreatePullRequest { deleteBranchProtectionRule(input: $i) { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: [], mutation: ["createPullRequest"] });
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.deniedFields).toEqual(["deleteBranchProtectionRule"]);
		}
	});

	it("allows all mutations with mutation: ['*']", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation X { deleteRepository(input: $i) { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: [], mutation: ["*"] });
		expect(result.allowed).toBe(true);
	});

	it("supports glob patterns", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation X { createPullRequest(input: $i) { id } createIssue(input: $j) { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: [], mutation: ["create*"] });
		expect(result.allowed).toBe(true);
	});

	it("denies when no rules match the operation type", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation X { createIssue(input: $i) { id } }",
			}),
		)!;
		// Only query rules, no mutation rules
		const result = checkGraphQLPolicy(ops, { query: ["*"], mutation: [] });
		expect(result.allowed).toBe(false);
	});

	it("handles mixed allowed and denied fields", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation X { createPullRequest(input: $i) { id } mergePullRequest(input: $j) { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: [], mutation: ["createPullRequest"] });
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.deniedFields).toEqual(["mergePullRequest"]);
		}
	});

	it("denies subscription operations (no rules)", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "subscription X { onIssueCreated { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: ["*"], mutation: ["*"] });
		expect(result.allowed).toBe(false);
	});

	it("is case-insensitive for field matching", () => {
		const ops = parseGraphQLBody(
			JSON.stringify({
				query: "mutation X { CreatePullRequest(input: $i) { id } }",
			}),
		)!;
		const result = checkGraphQLPolicy(ops, { query: [], mutation: ["createpullrequest"] });
		expect(result.allowed).toBe(true);
	});
});
