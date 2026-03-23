/**
 * GraphQL policy enforcement.
 *
 * Parses GraphQL request bodies to extract operation types and
 * top-level field names, then checks them against a configured
 * allow list.
 *
 * This provides defense-in-depth: the operation name is client-controlled
 * and can't be trusted, but the actual field names in the selection set
 * reveal what the mutation really does.
 */

import { type DocumentNode, type OperationDefinitionNode, parse } from "graphql";

export interface GraphQLOperation {
	/** "query" | "mutation" | "subscription" */
	type: string;
	/** Operation name (may be undefined for anonymous operations) */
	name: string | undefined;
	/** Top-level field names in the selection set */
	fields: string[];
}

/**
 * Parse a GraphQL request body and extract operations.
 * Returns undefined if the body can't be parsed.
 */
export function parseGraphQLBody(body: string): GraphQLOperation[] | undefined {
	let json: { query?: string };
	try {
		json = JSON.parse(body);
	} catch {
		return undefined;
	}

	const query = json.query;
	if (typeof query !== "string") return undefined;

	let doc: DocumentNode;
	try {
		doc = parse(query);
	} catch {
		return undefined;
	}

	const operations: GraphQLOperation[] = [];
	for (const def of doc.definitions) {
		if (def.kind !== "OperationDefinition") continue;
		const opDef = def as OperationDefinitionNode;
		const fields: string[] = [];
		for (const sel of opDef.selectionSet.selections) {
			if (sel.kind === "Field") {
				fields.push(sel.name.value);
			}
		}
		operations.push({
			type: opDef.operation,
			name: opDef.name?.value,
			fields,
		});
	}

	return operations;
}

/**
 * Check whether a GraphQL request should be allowed based on the policy.
 *
 * The allow object maps operation types to field patterns:
 *   { query: ["*"], mutation: ["createPullRequest", "create*"] }
 *
 * Returns allowed: true if all operations match, or details about denied fields.
 */
export function checkGraphQLPolicy(
	operations: GraphQLOperation[],
	allow: { query: string[]; mutation: string[] },
): { allowed: true } | { allowed: false; denied: GraphQLOperation[]; deniedFields: string[] } {
	const denied: GraphQLOperation[] = [];
	const deniedFields: string[] = [];

	for (const op of operations) {
		const patterns = op.type === "query" ? allow.query : op.type === "mutation" ? allow.mutation : undefined;

		if (!patterns || patterns.length === 0) {
			// No rules for this operation type
			denied.push(op);
			deniedFields.push(...op.fields);
			continue;
		}

		// Check if all fields match at least one pattern
		const unmatchedFields = op.fields.filter((field) => !patterns.some((p) => globMatch(p, field)));

		if (unmatchedFields.length > 0) {
			denied.push(op);
			deniedFields.push(...unmatchedFields);
		}
	}

	if (denied.length === 0) return { allowed: true };
	return { allowed: false, denied, deniedFields };
}

/**
 * Simple glob match: * matches any sequence of characters.
 */
function globMatch(pattern: string, value: string): boolean {
	if (pattern === "*") return true;
	// Convert glob to regex: escape regex chars, replace * with .*
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}
