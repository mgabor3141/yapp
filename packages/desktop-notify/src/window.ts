/**
 * Compositor window capture and click-to-focus.
 *
 * Captures the currently focused window ID at initialization time, then
 * provides focusWindow() to bring it back to front on notification click.
 *
 * Supports: macOS, niri, sway, hyprland.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface WindowHandle {
	compositor: "niri" | "sway" | "hyprland" | "macos";
	id: string;
}

let capturedWindow: WindowHandle | null = null;

/**
 * Capture the currently focused window's ID from the compositor.
 * Call when the terminal is guaranteed to be focused (e.g. session start).
 * Idempotent — subsequent calls update the captured window.
 */
export async function captureWindowId(): Promise<void> {
	try {
		if (process.platform === "darwin") {
			const bundleId = process.env.__CFBundleIdentifier;
			if (bundleId) {
				capturedWindow = { compositor: "macos", id: bundleId };
			}
			return;
		}

		if (process.env.NIRI_SOCKET) {
			const { stdout } = await execFileAsync("niri", ["msg", "--json", "focused-window"], { timeout: 2000 });
			const win = JSON.parse(stdout);
			if (win.id != null) {
				capturedWindow = { compositor: "niri", id: String(win.id) };
			}
		} else if (process.env.SWAYSOCK) {
			const { stdout } = await execFileAsync("swaymsg", ["-t", "get_tree"], { timeout: 2000 });
			const focused = findFocused(JSON.parse(stdout));
			if (focused?.id != null) {
				capturedWindow = { compositor: "sway", id: String(focused.id) };
			}
		} else if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
			const { stdout } = await execFileAsync("hyprctl", ["activewindow", "-j"], { timeout: 2000 });
			const win = JSON.parse(stdout);
			if (win.address) {
				capturedWindow = { compositor: "hyprland", id: win.address };
			}
		}
	} catch {
		// Silently fail — notifications still work, just no click-to-focus
	}
}

/** Focus the previously captured window. */
export function focusWindow(): void {
	if (!capturedWindow) return;

	try {
		switch (capturedWindow.compositor) {
			case "niri":
				execFile("niri", ["msg", "action", "focus-window", "--id", capturedWindow.id], () => {});
				break;
			case "sway":
				execFile("swaymsg", [`[con_id=${capturedWindow.id}] focus`], () => {});
				break;
			case "hyprland":
				execFile("hyprctl", ["dispatch", "focuswindow", `address:${capturedWindow.id}`], () => {});
				break;
			case "macos": {
				const appName = capturedWindow.id.split(".").pop() ?? capturedWindow.id;
				execFile("osascript", ["-e", `tell application "${appName}" to activate`], () => {});
				break;
			}
		}
	} catch {
		// Best-effort
	}
}

// biome-ignore lint/suspicious/noExplicitAny: untyped compositor JSON
function findFocused(node: any): any {
	if (node.focused) return node;
	for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
		const found = findFocused(child);
		if (found) return found;
	}
	return null;
}
