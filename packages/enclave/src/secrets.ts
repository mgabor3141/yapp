/**
 * Secret resolution for pi-enclave.
 *
 * Secrets are sourced from the host and never enter the VM.
 * The VM sees placeholder values; the Gondolin HTTP proxy substitutes
 * real values only for requests to configured hosts.
 *
 * All secrets are explicitly configured in .pi/enclave.toml or the
 * global config. There is no auto-detection.
 */

import { execSync } from "node:child_process";
import type { EnvDef, ResolvedSecret, SecretDef } from "./config.js";

export type { ResolvedSecret } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commandExists(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function runCommand(command: string): string | undefined {
	try {
		const result = execSync(command, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		});
		const trimmed = result.trim();
		return trimmed || undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single secret definition into a value + hosts, or undefined if
 * the source is unavailable (tool not installed, env var not set, etc.).
 */
function resolveSource(name: string, source: SecretDef): ResolvedSecret | undefined {
	if (source === false) return undefined;

	if ("command" in source) {
		// Check if the command's binary exists before running it
		const binary = source.command.split(/\s+/)[0];
		if (binary && !commandExists(binary)) return undefined;

		const value = runCommand(source.command);
		if (!value) return undefined;
		return { name, value, hosts: source.hosts };
	}

	if ("env" in source) {
		const value = process.env[source.env];
		if (!value) return undefined;
		return { name, value, hosts: source.hosts };
	}

	return undefined;
}

/**
 * Resolve all secrets from config.
 * Secrets whose source is unavailable (command not found, env var not set)
 * are silently skipped.
 */
export function resolveSecrets(configSecrets: Record<string, SecretDef> = {}): ResolvedSecret[] {
	const resolved: ResolvedSecret[] = [];

	for (const [name, source] of Object.entries(configSecrets)) {
		const secret = resolveSource(name, source);
		if (secret) resolved.push(secret);
	}

	return resolved;
}

/**
 * Resolve environment variable definitions into key-value pairs.
 * Entries whose source is unavailable are silently skipped.
 */
export function resolveEnv(configEnv: Record<string, EnvDef> = {}): Record<string, string> {
	const resolved: Record<string, string> = {};

	for (const [name, def] of Object.entries(configEnv)) {
		if (typeof def === "string") {
			resolved[name] = def;
			continue;
		}

		if ("command" in def) {
			const binary = def.command.split(/\s+/)[0];
			if (binary && !commandExists(binary)) continue;
			const value = runCommand(def.command);
			if (value) resolved[name] = value;
			continue;
		}

		if ("env" in def) {
			const value = process.env[def.env];
			if (value) resolved[name] = value;
		}
	}

	return resolved;
}
