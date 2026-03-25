/**
 * ESM loader hooks that replace node:fs and node:fs/promises imports with
 * wrapper modules. Path-taking functions delegate through the CJS exports
 * object so monkey-patches are visible. All other exports (constants,
 * classes, fd-based functions) are re-exported directly.
 *
 * Registered via module.register() in tmp-redirect.ts.
 * Runs in a separate loader worker thread.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Functions that need delegation (path-taking, may be monkey-patched).
// Delegation means: export function X(...a) { return _m.X(...a); }
// This ensures each call reads the CURRENT value of _m.X, picking up patches.
// ---------------------------------------------------------------------------

const FS_DELEGATED = new Set([
	// single-path sync
	"accessSync",
	"appendFileSync",
	"chmodSync",
	"chownSync",
	"existsSync",
	"lstatSync",
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
	// single-path async (callback)
	"access",
	"appendFile",
	"chmod",
	"chown",
	"exists",
	"lstat",
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
	// streams
	"createReadStream",
	"createWriteStream",
	// two-path sync
	"copyFileSync",
	"cpSync",
	"linkSync",
	"renameSync",
	"symlinkSync",
	// two-path async (callback)
	"copyFile",
	"cp",
	"link",
	"rename",
	"symlink",
	// glob (takes path patterns)
	"glob",
	"globSync",
	// watch (takes path)
	"watch",
	"watchFile",
	"unwatchFile",
	// lchmod/lchown (take path)
	"lchmodSync",
	"lchmod",
	"lchownSync",
	"lchown",
	"lutimesSync",
	"lutimes",
]);

const FSP_DELEGATED = new Set([
	"access",
	"appendFile",
	"chmod",
	"chown",
	"copyFile",
	"cp",
	"glob",
	"lchmod",
	"lchown",
	"link",
	"lstat",
	"lutimes",
	"mkdir",
	"mkdtemp",
	"open",
	"opendir",
	"readFile",
	"readdir",
	"readlink",
	"realpath",
	"rename",
	"rm",
	"rmdir",
	"stat",
	"statfs",
	"symlink",
	"truncate",
	"unlink",
	"utimes",
	"writeFile",
	"watch",
]);

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

function generateWrapperSource(cjsModuleName, delegatedSet) {
	const mod = require(cjsModuleName);
	const lines = [
		"import { createRequire as _cr } from 'node:module';",
		"const _r = _cr('file:///tmp/_pi_enclave_loader.js');",
		`const _m = _r("${cjsModuleName}");`,
	];

	for (const key of Object.keys(mod)) {
		if (key === "default") continue;
		if (delegatedSet.has(key) && typeof mod[key] === "function") {
			// Delegated: each call looks up _m[key], so CJS patches are visible
			lines.push(`export function ${key}(...a) { return _m["${key}"](...a); }`);
		} else {
			// Direct re-export: constants, classes, fd-based functions
			lines.push(`export const ${key} = _m["${key}"];`);
		}
	}

	lines.push("export default _m;");
	return lines.join("\n");
}

const FS_SOURCE = generateWrapperSource("fs", FS_DELEGATED);
const FSP_SOURCE = generateWrapperSource("fs/promises", FSP_DELEGATED);

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "node:fs" || specifier === "fs") {
		return { shortCircuit: true, url: "pi-enclave:fs" };
	}
	if (specifier === "node:fs/promises" || specifier === "fs/promises") {
		return { shortCircuit: true, url: "pi-enclave:fs/promises" };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url === "pi-enclave:fs") {
		return { shortCircuit: true, format: "module", source: FS_SOURCE };
	}
	if (url === "pi-enclave:fs/promises") {
		return { shortCircuit: true, format: "module", source: FSP_SOURCE };
	}
	return nextLoad(url, context);
}
