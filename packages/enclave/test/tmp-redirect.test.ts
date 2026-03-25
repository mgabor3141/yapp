import fs from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TmpRedirect, installTmpRedirect } from "../src/tmp-redirect.js";

describe("tmp-redirect", () => {
	let redirect: TmpRedirect;

	beforeEach(() => {
		redirect = installTmpRedirect();
	});

	afterEach(() => {
		redirect.uninstall(true);
	});

	// -----------------------------------------------------------------------
	// CJS-level patching (module object access)
	// -----------------------------------------------------------------------

	it("redirects sync writes via module object", () => {
		fs.mkdirSync("/tmp/test-redirect-sync", { recursive: true });
		fs.writeFileSync("/tmp/test-redirect-sync/hello.txt", "world");

		const realPath = join(redirect.sharedDir, "test-redirect-sync/hello.txt");
		expect(fs.existsSync(realPath)).toBe(true);
		expect(fs.readFileSync("/tmp/test-redirect-sync/hello.txt", "utf8")).toBe("world");
	});

	it("redirects async writes via module object", async () => {
		await fsp.mkdir("/tmp/test-redirect-async", { recursive: true });
		await fsp.writeFile("/tmp/test-redirect-async/data.txt", "async-content");

		const content = await fsp.readFile("/tmp/test-redirect-async/data.txt", "utf8");
		expect(content).toBe("async-content");

		const realPath = join(redirect.sharedDir, "test-redirect-async/data.txt");
		expect(fs.existsSync(realPath)).toBe(true);
	});

	it("redirects mkdtempSync via module object", () => {
		const tmpDir = fs.mkdtempSync("/tmp/test-mkdtemp-");
		expect(tmpDir.startsWith(redirect.sharedDir)).toBe(true);
		fs.writeFileSync(join(tmpDir, "file.txt"), "in-mkdtemp");
		expect(fs.readFileSync(join(tmpDir, "file.txt"), "utf8")).toBe("in-mkdtemp");
	});

	it("redirects two-path operations (rename) via module object", async () => {
		await fsp.mkdir("/tmp/test-rename", { recursive: true });
		await fsp.writeFile("/tmp/test-rename/old.txt", "rename-me");
		await fsp.rename("/tmp/test-rename/old.txt", "/tmp/test-rename/new.txt");

		expect(fs.existsSync(join(redirect.sharedDir, "test-rename/new.txt"))).toBe(true);
		const content = await fsp.readFile("/tmp/test-rename/new.txt", "utf8");
		expect(content).toBe("rename-me");
	});

	it("redirects copyFile via module object", async () => {
		await fsp.mkdir("/tmp/test-copy", { recursive: true });
		await fsp.writeFile("/tmp/test-copy/src.txt", "copy-me");
		await fsp.copyFile("/tmp/test-copy/src.txt", "/tmp/test-copy/dst.txt");

		const content = await fsp.readFile("/tmp/test-copy/dst.txt", "utf8");
		expect(content).toBe("copy-me");
	});

	it("redirects createWriteStream / createReadStream", async () => {
		fs.mkdirSync("/tmp/test-stream", { recursive: true });

		await new Promise<void>((resolve, reject) => {
			const ws = fs.createWriteStream("/tmp/test-stream/out.txt");
			ws.write("streamed");
			ws.end();
			ws.on("finish", resolve);
			ws.on("error", reject);
		});

		const chunks: Buffer[] = [];
		await new Promise<void>((resolve, reject) => {
			const rs = fs.createReadStream("/tmp/test-stream/out.txt");
			rs.on("data", (chunk) => chunks.push(chunk as Buffer));
			rs.on("end", resolve);
			rs.on("error", reject);
		});
		expect(Buffer.concat(chunks).toString()).toBe("streamed");
	});

	// -----------------------------------------------------------------------
	// Guard and edge cases
	// -----------------------------------------------------------------------

	it("does not double-rewrite paths already under the shared dir", () => {
		fs.mkdirSync(join(redirect.sharedDir, "direct"), { recursive: true });
		fs.writeFileSync(join(redirect.sharedDir, "direct/file.txt"), "direct-write");
		expect(fs.readFileSync(join(redirect.sharedDir, "direct/file.txt"), "utf8")).toBe("direct-write");
	});

	it("handles bare /tmp path", () => {
		expect(fs.existsSync("/tmp")).toBe(true);
	});

	it("does not affect non-/tmp paths", () => {
		const testDir = fs.mkdtempSync(join(redirect.sharedDir, "non-tmp-"));
		fs.writeFileSync(join(testDir, "ok.txt"), "not-redirected");
		expect(fs.readFileSync(join(testDir, "ok.txt"), "utf8")).toBe("not-redirected");
	});

	it("ignores non-string paths", () => {
		expect(() => {
			try {
				fs.readFileSync(Buffer.from("/tmp/buffer-path") as unknown as string);
			} catch (e: unknown) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
				throw e;
			}
		}).not.toThrow();
	});

	it("restores original functions on uninstall", () => {
		redirect.uninstall(true);

		const testPath = `/tmp/pi-enclave-uninstall-test-${process.pid}`;
		try {
			fs.writeFileSync(testPath, "real-tmp");
			expect(fs.readFileSync(testPath, "utf8")).toBe("real-tmp");
		} finally {
			try {
				fs.rmSync(testPath);
			} catch {
				// cleanup
			}
		}

		// Reinstall for afterEach cleanup
		redirect = installTmpRedirect();
	});

	it("handles reinstall after uninstall (VM restart)", () => {
		// Simulate /enclave restart: uninstall, then install fresh
		const oldShared = redirect.sharedDir;
		fs.mkdirSync(join(oldShared, "before-restart"), { recursive: true });
		fs.writeFileSync(join(oldShared, "before-restart/data.txt"), "old-data");

		redirect.uninstall(true);
		expect(fs.existsSync(oldShared)).toBe(false);

		redirect = installTmpRedirect();
		// New install works, old data is gone (clean slate)
		expect(fs.existsSync("/tmp/before-restart/data.txt")).toBe(false);

		// New writes work
		fs.mkdirSync("/tmp/after-restart", { recursive: true });
		fs.writeFileSync("/tmp/after-restart/data.txt", "new-data");
		expect(fs.readFileSync("/tmp/after-restart/data.txt", "utf8")).toBe("new-data");
	});

	it("leaves paths outside /tmp untouched", () => {
		// /var should resolve normally (not rewritten)
		expect(() => fs.statSync("/var")).not.toThrow();
		// A non-existent path outside /tmp should fail with its original path
		try {
			fs.readFileSync("/var/nonexistent-redirect-test");
		} catch (e: unknown) {
			expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
			expect((e as NodeJS.ErrnoException).message).not.toContain(redirect.sharedDir);
		}
	});

	it("cleans up shared directory on uninstall", () => {
		const sharedDir = redirect.sharedDir;
		fs.mkdirSync(join(sharedDir, "cleanup-test"), { recursive: true });
		fs.writeFileSync(join(sharedDir, "cleanup-test/file.txt"), "to-be-cleaned");

		redirect.uninstall(true);
		// After uninstall, patched fs.existsSync still delegates to the
		// restored original (loader hooks are still active but the CJS
		// exports are back to normal), so this checks the real filesystem.
		expect(fs.existsSync(sharedDir)).toBe(false);

		redirect = installTmpRedirect();
	});
});
