/**
 * pi extension entry point for pi-desktop-notify.
 *
 * When installed as a pi package, this automatically:
 * - Starts terminal focus tracking (DECSET 1004)
 * - Captures the compositor window ID for click-to-focus
 * - Sends a desktop notification when the agent goes idle
 * - Cleans up focus tracking on session shutdown
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startFocusTracking, stopFocusTracking } from "./focus.js";
import { sendNotification } from "./notify.js";
import { captureWindowId } from "./window.js";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx) => {
		startFocusTracking();
		await captureWindowId();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		stopFocusTracking();
	});

	pi.on("agent_end", async (_event, ctx) => {
		await sendNotification({
			title: "✅ Task complete",
			body: "Pi is waiting for input",
			cwd: ctx.cwd,
		});
	});
}
