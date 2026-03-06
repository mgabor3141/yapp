/**
 * Cross-platform desktop notification dispatch.
 *
 * - macOS: terminal-notifier with click-to-focus
 * - Linux: notify-send with compositor-specific click-to-focus
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isTerminalFocused } from "./focus.js";
import { focusWindow } from "./window.js";

const execFileAsync = promisify(execFile);

export interface NotifyOptions {
	title: string;
	body: string;
	/** cwd for macOS click-to-focus (defaults to process.cwd()) */
	cwd?: string;
	/** Skip notification if terminal is focused (default: true) */
	skipIfFocused?: boolean;
	/** Always notify even when terminal is focused (default: false). Overrides skipIfFocused. */
	skipIfForeground?: boolean;
}

export async function sendNotification(opts: NotifyOptions): Promise<void> {
	const { title, body, cwd = process.cwd() } = opts;
	const skip = opts.skipIfForeground === false ? false : (opts.skipIfFocused ?? true);

	if (skip && isTerminalFocused()) return;

	if (process.platform === "darwin") {
		await notifyMacOS(title, body, cwd);
	} else if (process.platform === "linux") {
		notifyLinux(title, body);
	}
}

function notifyLinux(title: string, body: string): void {
	const args = ["--app-name=Pi", "--urgency=critical", title, body, "--action=default=Focus terminal"];

	const proc = execFile("notify-send", args, () => {});

	if (proc.stdout) {
		proc.stdout.on("data", (data: Buffer) => {
			if (data.toString().trim() === "default") {
				focusWindow();
			}
		});
	}
}

async function notifyMacOS(title: string, body: string, cwd: string): Promise<void> {
	const bundleId = process.env.__CFBundleIdentifier;
	if (!bundleId) return;

	const args = ["-title", "Pi", "-subtitle", title, "-message", body, "-sound", "default", "-ignoreDnD"];

	if (process.env.ZED_TERM) {
		let zedPath: string;
		try {
			const { stdout } = await execFileAsync("which", ["zed"], { timeout: 1000 });
			zedPath = stdout.trim() || "zed";
		} catch {
			zedPath = "zed";
		}
		args.push("-execute", `${zedPath} ${cwd}`);
	} else {
		args.push("-activate", bundleId);
	}

	execFile("terminal-notifier", args, () => {});
}
