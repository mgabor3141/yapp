import { execSync } from "node:child_process";
import { platform } from "node:os";

/** Return the platform-appropriate suspend command. */
export function sleepCommand(os = platform()): string {
	switch (os) {
		case "darwin":
			return "pmset sleepnow";
		case "linux":
			return "systemctl suspend";
		default:
			return "";
	}
}

/** Put the computer to sleep. Returns true if the command was issued. */
export function suspendSystem(os = platform()): boolean {
	const cmd = sleepCommand(os);
	if (!cmd) return false;
	try {
		execSync(cmd, { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}
