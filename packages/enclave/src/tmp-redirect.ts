/**
 * Redirect /tmp file operations to a shared subdirectory.
 *
 * Two layers ensure comprehensive interception:
 *
 * 1. **ESM loader hooks** (via module.register): replace node:fs and
 *    node:fs/promises imports with wrapper modules whose exports delegate
 *    through the CJS exports object. This makes ESM static named imports
 *    (e.g. `import { writeFileSync } from "node:fs"`) see CJS-level patches
 *    for any module loaded AFTER registration.
 *
 * 2. **CJS monkey-patch**: rewrites /tmp paths on the actual require("fs")
 *    and require("fs/promises") exports. The wrapper modules from layer 1
 *    call through these patched functions.
 *
 * Limitation: code that imported node:fs before registration (pi's own
 * internals, the enclave extension itself) retains original bindings.
 * This is fine since those modules don't write to /tmp for the agent.
 */

import { createRequire } from "node:module";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const fsModule = require("node:fs") as typeof import("node:fs");
const fspModule = require("node:fs/promises") as typeof import("node:fs/promises");

const TMP_PREFIX = "/tmp/";

// ---------------------------------------------------------------------------
// Path rewriting
// ---------------------------------------------------------------------------

function makeRewriter(sharedDir: string): (p: unknown) => unknown {
	return (p: unknown): unknown => {
		if (typeof p !== "string") return p;
		if (p === "/tmp") return sharedDir;
		if (p.startsWith(TMP_PREFIX) && !p.startsWith(`${sharedDir}/`) && p !== sharedDir) {
			return join(sharedDir, p.slice(TMP_PREFIX.length));
		}
		return p;
	};
}

// ---------------------------------------------------------------------------
// CJS monkey-patching
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

function wrap1(obj: Record<string, AnyFn>, name: string, rewrite: (p: unknown) => unknown): void {
	const orig = obj[name];
	if (typeof orig !== "function") return;
	obj[name] = function (this: unknown, p: unknown, ...rest: unknown[]) {
		return orig.call(this, rewrite(p), ...rest);
	};
	Object.defineProperty(obj[name], "name", { value: name });
}

function wrap2(obj: Record<string, AnyFn>, name: string, rewrite: (p: unknown) => unknown): void {
	const orig = obj[name];
	if (typeof orig !== "function") return;
	obj[name] = function (this: unknown, p1: unknown, p2: unknown, ...rest: unknown[]) {
		return orig.call(this, rewrite(p1), rewrite(p2), ...rest);
	};
	Object.defineProperty(obj[name], "name", { value: name });
}

const SINGLE_PATH_SYNC = [
	"accessSync",
	"appendFileSync",
	"chmodSync",
	"chownSync",
	"existsSync",
	"lchmodSync",
	"lchownSync",
	"lstatSync",
	"lutimesSync",
	"mkdirSync",
	"mkdtempSync",
	"opendirSync",
	"openSync",
	"readdirSync",
	"readFileSync",
	"readlinkSync",
	"realpathSync",
	"rmdirSync",
	"rmSync",
	"statSync",
	"statfsSync",
	"truncateSync",
	"unlinkSync",
	"utimesSync",
	"writeFileSync",
	"globSync",
	"watch",
	"watchFile",
	"unwatchFile",
];

const SINGLE_PATH_ASYNC = [
	"access",
	"appendFile",
	"chmod",
	"chown",
	"exists",
	"lchmod",
	"lchown",
	"lstat",
	"lutimes",
	"mkdir",
	"mkdtemp",
	"open",
	"opendir",
	"readdir",
	"readFile",
	"readlink",
	"realpath",
	"rm",
	"rmdir",
	"stat",
	"statfs",
	"truncate",
	"unlink",
	"utimes",
	"writeFile",
	"glob",
];

const SINGLE_PATH_STREAM = ["createReadStream", "createWriteStream"];
const TWO_PATH_SYNC = ["copyFileSync", "cpSync", "linkSync", "renameSync", "symlinkSync"];
const TWO_PATH_ASYNC = ["copyFile", "cp", "link", "rename", "symlink"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TmpRedirect {
	/** The host-side shared directory (mounted at /tmp in the VM). */
	sharedDir: string;
	/** Remove the monkey-patches and optionally delete the shared directory. */
	uninstall(cleanup?: boolean): void;
}

/**
 * Install /tmp redirection:
 * 1. Register ESM loader hooks (intercepts future node:fs imports)
 * 2. Patch CJS require("fs") exports (path rewriting)
 * 3. Create the shared directory
 */
export function installTmpRedirect(): TmpRedirect {
	const sharedDir = join("/tmp", `pi-enclave-${process.pid}`);

	const fsAny = fsModule as unknown as Record<string, AnyFn>;
	const fspAny = fspModule as unknown as Record<string, AnyFn>;

	// Save originals before patching.
	const origMkdirSync = fsAny.mkdirSync as typeof fsModule.mkdirSync;
	const origRmSync = fsAny.rmSync as typeof fsModule.rmSync;

	origMkdirSync(sharedDir, { recursive: true });

	// Register ESM loader hooks so future imports of node:fs go through
	// wrapper modules that delegate to the (now-patched) CJS exports.
	const hooksPath = join(dirname(fileURLToPath(import.meta.url)), "fs-loader-hooks.mjs");
	register(pathToFileURL(hooksPath).href, import.meta.url);

	const rewrite = makeRewriter(sharedDir);

	// Save originals for uninstall.
	const origFs: Record<string, AnyFn> = {};
	const origFsp: Record<string, AnyFn> = {};

	function save(obj: Record<string, AnyFn>, store: Record<string, AnyFn>, names: string[]) {
		for (const n of names) {
			if (typeof obj[n] === "function") store[n] = obj[n];
		}
	}

	const allFsNames = [
		...SINGLE_PATH_SYNC,
		...SINGLE_PATH_ASYNC,
		...SINGLE_PATH_STREAM,
		...TWO_PATH_SYNC,
		...TWO_PATH_ASYNC,
	];
	const allFspNames = [...SINGLE_PATH_ASYNC, ...TWO_PATH_ASYNC];

	save(fsAny, origFs, allFsNames);
	save(fspAny, origFsp, allFspNames);

	// Patch CJS exports (the wrapper modules from the loader hooks delegate here).
	for (const n of [...SINGLE_PATH_SYNC, ...SINGLE_PATH_ASYNC, ...SINGLE_PATH_STREAM]) wrap1(fsAny, n, rewrite);
	for (const n of [...TWO_PATH_SYNC, ...TWO_PATH_ASYNC]) wrap2(fsAny, n, rewrite);

	for (const n of SINGLE_PATH_ASYNC) wrap1(fspAny, n, rewrite);
	for (const n of TWO_PATH_ASYNC) wrap2(fspAny, n, rewrite);

	return {
		sharedDir,
		uninstall(cleanup = true) {
			for (const [n, fn] of Object.entries(origFs)) fsAny[n] = fn;
			for (const [n, fn] of Object.entries(origFsp)) fspAny[n] = fn;

			// Note: loader hooks cannot be unregistered (no API for that).
			// After uninstall the wrapper modules still delegate to the CJS
			// exports, which are now restored to originals, so the net effect
			// is transparent.

			if (cleanup) {
				try {
					origRmSync(sharedDir, { recursive: true, force: true });
				} catch {
					// Best-effort cleanup
				}
			}
		},
	};
}
