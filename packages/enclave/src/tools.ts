/**
 * VM-backed tool operations.
 *
 * Implementations of pi's ReadOperations, WriteOperations, EditOperations,
 * and BashOperations that delegate to a Gondolin VM. Since the workspace is
 * mounted at the same path inside the VM as on the host, paths are passed
 * through unchanged.
 */

import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@mariozechner/pi-coding-agent";

export function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createVmReadOps(vm: VM): ReadOperations {
	return {
		readFile: async (p) => {
			const r = await vm.exec(["/bin/cat", p]);
			if (!r.ok) throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
			return r.stdoutBuffer;
		},
		access: async (p) => {
			const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(p)}`]);
			if (!r.ok) throw new Error(`not readable: ${p}`);
		},
		detectImageMimeType: async (p) => {
			try {
				const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(p)}`]);
				if (!r.ok) return null;
				const m = r.stdout.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

export function createVmWriteOps(vm: VM): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const dir = path.posix.dirname(p);
			const b64 = Buffer.from(content, "utf8").toString("base64");
			const script = ["set -eu", `mkdir -p ${shQuote(dir)}`, `echo ${shQuote(b64)} | base64 -d > ${shQuote(p)}`].join(
				"\n",
			);
			const r = await vm.exec(["/bin/sh", "-lc", script]);
			if (!r.ok) throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
		},
		mkdir: async (dir) => {
			const r = await vm.exec(["/bin/mkdir", "-p", dir]);
			if (!r.ok) throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
		},
	};
}

export function createVmEditOps(vm: VM): EditOperations {
	const r = createVmReadOps(vm);
	const w = createVmWriteOps(vm);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

/**
 * Strip host environment variables. The VM has its own clean environment;
 * we only pass through non-secret variables like TERM, LANG, etc.
 * Secrets are injected by the HTTP proxy, not via env vars.
 */
const ENV_PASSTHROUGH = new Set(["TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "EDITOR", "VISUAL", "PAGER"]);

function sanitizeEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
	if (!env) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (typeof v === "string" && ENV_PASSTHROUGH.has(k)) out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function createVmBashOps(vm: VM): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const ac = new AbortController();
			const onAbort = () => ac.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							ac.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec(["/bin/sh", "-lc", command], {
					cwd,
					signal: ac.signal,
					env: sanitizeEnv(env),
					stdout: "pipe",
					stderr: "pipe",
				});

				for await (const chunk of proc.output()) {
					onData(chunk.data);
				}

				const r = await proc;
				return { exitCode: r.exitCode };
			} catch (err) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw err;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
