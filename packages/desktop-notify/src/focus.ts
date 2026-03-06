/**
 * Terminal focus tracking via DECSET 1004.
 *
 * Enables focus reporting so the terminal sends \x1b[I (focus in) and
 * \x1b[O (focus out). These are intercepted on process.stdin before
 * the host application's input handler sees them.
 *
 * Works with any terminal supporting DECSET 1004:
 * Zed, kitty, wezterm, foot, alacritty, iTerm2, etc.
 * Also works through abduco/tmux (they relay escape sequences).
 */

let focused = true;
let stdinListener: ((data: Buffer | string) => void) | null = null;

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE = "\x1b[?1004h";
const DISABLE = "\x1b[?1004l";

/**
 * Start tracking terminal focus. Idempotent — safe to call multiple times.
 */
export function startFocusTracking(): void {
	if (stdinListener) return;

	process.stdout.write(ENABLE);

	stdinListener = (data: Buffer | string) => {
		const str = data.toString();
		if (str.includes(FOCUS_IN)) focused = true;
		if (str.includes(FOCUS_OUT)) focused = false;
	};

	process.stdin.prependListener("data", stdinListener);
}

/**
 * Stop tracking and disable focus reporting.
 */
export function stopFocusTracking(): void {
	if (stdinListener) {
		process.stdin.removeListener("data", stdinListener);
		stdinListener = null;
		process.stdout.write(DISABLE);
	}
}

/**
 * Returns true if the terminal is currently focused.
 * Defaults to true before tracking starts.
 */
export function isTerminalFocused(): boolean {
	return focused;
}
