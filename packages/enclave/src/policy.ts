/**
 * HTTP method+path policy enforcement.
 *
 * Per-host rules define allowed methods and path patterns.
 * Deny patterns always win. Unmatched requests can prompt, deny, or allow.
 */

import type { ResolvedHostPolicy } from "./config.js";

export type PolicyDecision = "allow" | "deny" | "prompt";

/**
 * Match a URL path against a pattern.
 *
 * Pattern syntax:
 * - `*` (single star) matches exactly one path segment
 * - `**` (double star) matches the rest of the path (must be last)
 * - Literal segments match exactly
 */
export function matchPath(pattern: string, path: string): boolean {
	// Normalize: ensure leading slash, strip trailing slash
	const normPattern = pattern.startsWith("/") ? pattern : `/${pattern}`;
	const normPath = path.startsWith("/") ? path : `/${path}`;

	const patternParts = normPattern.split("/").filter(Boolean);
	const pathParts = normPath.split("/").filter(Boolean);

	let pi = 0;
	let pp = 0;

	while (pi < patternParts.length && pp < pathParts.length) {
		const pat = patternParts[pi];

		if (pat === "**") {
			// ** matches zero or more remaining segments
			return true;
		}

		if (pat === "*") {
			// Match exactly one segment
			pi++;
			pp++;
			continue;
		}

		// Literal match
		if (pat !== pathParts[pp]) {
			return false;
		}

		pi++;
		pp++;
	}

	// ** at the end matches zero remaining segments
	if (pi < patternParts.length && patternParts[pi] === "**") {
		return true;
	}

	// Both must be exhausted
	return pi === patternParts.length && pp === pathParts.length;
}

/**
 * Check a request against a host policy.
 */
export function checkPolicy(policy: ResolvedHostPolicy, method: string, path: string): PolicyDecision {
	const upperMethod = method.toUpperCase();

	// Deny patterns always win
	for (const pattern of policy.deny) {
		if (matchPath(pattern, path)) {
			return "deny";
		}
	}

	// Check method-specific allows
	const allowedPatterns = policy.allows.get(upperMethod);
	if (allowedPatterns) {
		for (const pattern of allowedPatterns) {
			if (matchPath(pattern, path)) {
				return "allow";
			}
		}
	}

	// No explicit allow matched
	return policy.unmatched;
}

/**
 * Evaluate an HTTP request against all policies.
 *
 * Returns "allow" if no policy exists for the host (open by default).
 */
export function evaluateRequest(
	policies: Map<string, ResolvedHostPolicy>,
	hostname: string,
	method: string,
	path: string,
): PolicyDecision {
	const policy = policies.get(hostname);
	if (!policy) return "allow";
	return checkPolicy(policy, method, path);
}
