/**
 * After-Hours Message Limits — prevents hyperfocus-driven late-night agent sessions
 * by implementing a message budget that gracefully interrupts the engagement loop.
 *
 * During quiet hours (default 23:00–07:00), the user gets a configurable number of
 * messages (default 3). After the budget is spent, the UI is blocked with a
 * full-screen terminal takeover until quiet hours end.
 *
 * Counter persists across sessions via a date-keyed state file in /tmp.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, matchesKey, visibleWidth } from "@mariozechner/pi-tui";

import { type AfterHoursConfig, isInQuietHours, isPastWarningTime, loadConfig, toMinutes } from "./config.js";
import { type CounterState, loadCounter, saveCounter, todayStr } from "./counter.js";

export { AfterHoursConfig } from "./config.js";
export type { CounterState } from "./counter.js";

function nowMinutes(): number {
	const d = new Date();
	return d.getHours() * 60 + d.getMinutes();
}

function checkQuietHours(config: AfterHoursConfig): boolean {
	return isInQuietHours(nowMinutes(), toMinutes(config.quietHoursStart), toMinutes(config.quietHoursEnd));
}

function checkWarningTime(config: AfterHoursConfig): boolean {
	const now = nowMinutes();
	const inQuiet = isInQuietHours(now, toMinutes(config.quietHoursStart), toMinutes(config.quietHoursEnd));
	return isPastWarningTime(now, toMinutes(config.warningTime), toMinutes(config.quietHoursEnd), inQuiet);
}

export default function (pi: ExtensionAPI) {
	let config: AfterHoursConfig;
	try {
		config = loadConfig();
	} catch (err) {
		// Log and bail — don't break pi if config is bad
		console.error(err instanceof Error ? err.message : err);
		return;
	}

	if (!config.enabled) return;

	let counter = loadCounter();
	let uiBlocked = false;
	let widgetShown = false;
	let currentCtx: ExtensionContext | null = null;
	let warningCheckInterval: ReturnType<typeof setInterval> | null = null;

	function remaining(): number {
		return Math.max(0, config.messageLimit - counter.messagesUsed);
	}

	function refreshCounter(): void {
		const today = todayStr();
		if (counter.date !== today) {
			counter = { date: today, messagesUsed: 0 };
			saveCounter(counter);
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		refreshCounter();

		if (!checkQuietHours(config) || remaining() <= 0) {
			if (widgetShown) {
				ctx.ui.setWidget("after-hours", undefined);
				widgetShown = false;
			}
			return;
		}

		if (checkWarningTime(config) || counter.messagesUsed > 0) {
			const r = remaining();
			const plural = r === 1 ? "message" : "messages";
			ctx.ui.setWidget("after-hours", (_tui, theme) => {
				return new Text(theme.fg("warning", `🌙 Quiet hours active. ${r} ${plural} remaining tonight.`), 0, 0);
			});
			widgetShown = true;
		}
	}

	function blockUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI || uiBlocked) return;
		uiBlocked = true;

		ctx.ui.setWidget("after-hours", undefined);
		ctx.ui.setStatus("after-hours", undefined);
		widgetShown = false;

		const msg = config.blockMessage;
		const endTime = config.quietHoursEnd;

		// Take over the terminal directly — stop the TUI, clear screen, render
		// our own content with raw stdin handling. Same pattern as interactive-shell.
		ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

			const renderBlock = () => {
				const width = process.stdout.columns || 80;
				const height = process.stdout.rows || 24;

				const centerH = (s: string) => {
					const pad = Math.max(0, Math.floor((width - visibleWidth(s)) / 2));
					return " ".repeat(pad) + s;
				};

				const boxWidth = Math.min(60, width - 4);
				const boxInner = boxWidth - 2;
				const hBar = "─".repeat(boxInner);
				const dim = (s: string) => theme.fg("dim", s);

				const centerInBox = (s: string) => {
					const totalPad = Math.max(0, boxInner - visibleWidth(s));
					const left = Math.floor(totalPad / 2);
					return dim("│") + " ".repeat(left) + s + " ".repeat(totalPad - left) + dim("│");
				};
				const emptyRow = centerInBox("");

				const boxLines = [
					dim(`╭${hBar}╮`),
					emptyRow,
					emptyRow,
					centerInBox("🌙"),
					emptyRow,
					emptyRow,
					centerInBox(msg),
					emptyRow,
					centerInBox(`Quiet hours end at ${endTime}`),
					emptyRow,
					emptyRow,
					centerInBox(dim("Ctrl+C to exit")),
					emptyRow,
					emptyRow,
					dim(`╰${hBar}╯`),
				];

				const lines: string[] = [];
				const topPad = Math.max(0, Math.floor((height - boxLines.length) / 2));
				for (let i = 0; i < topPad; i++) lines.push("");
				for (const bl of boxLines) lines.push(centerH(bl));
				while (lines.length < height) lines.push("");

				const padded = lines.map((l) => l + " ".repeat(Math.max(0, width - visibleWidth(l))));
				process.stdout.write(`\x1b[H${padded.join("\n")}`);
			};

			renderBlock();

			const resizeHandler = () => renderBlock();
			process.stdout.on("resize", resizeHandler);

			const checkInterval = setInterval(() => {
				refreshCounter();
				if (!checkQuietHours(config)) cleanup();
			}, 60_000);

			const stdinHandler = (data: Buffer) => {
				const str = data.toString();
				if (matchesKey(str, "ctrl+c") || matchesKey(str, "ctrl+d")) {
					cleanup();
					ctx.shutdown();
				}
			};
			if (process.stdin.readable) process.stdin.on("data", stdinHandler);

			const cleanup = () => {
				clearInterval(checkInterval);
				process.stdout.removeListener("resize", resizeHandler);
				if (process.stdin.readable) process.stdin.removeListener("data", stdinHandler);
				uiBlocked = false;
				process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
				tui.start();
				tui.requestRender(true);
				done();
			};

			return { render: () => [], handleInput() {}, invalidate() {} };
		});
	}

	// --- Events ---

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		refreshCounter();

		if (checkQuietHours(config) && remaining() <= 0) {
			blockUI(ctx);
			return;
		}

		updateWidget(ctx);

		if (warningCheckInterval) clearInterval(warningCheckInterval);
		warningCheckInterval = setInterval(() => {
			if (currentCtx) updateWidget(currentCtx);
		}, 60_000);
	});

	pi.on("input", async (_event, ctx) => {
		if (!config.enabled) return { action: "continue" as const };
		refreshCounter();

		if (!checkQuietHours(config)) return { action: "continue" as const };

		if (remaining() <= 0) {
			blockUI(ctx);
			return { action: "handled" as const };
		}

		counter.messagesUsed++;
		saveCounter(counter);

		if (remaining() <= 0) {
			ctx.ui.setWidget("after-hours", undefined);
			widgetShown = false;
			setTimeout(() => blockUI(ctx), 500);
		} else {
			updateWidget(ctx);
		}

		return { action: "continue" as const };
	});

	pi.on("session_shutdown", async () => {
		if (warningCheckInterval) {
			clearInterval(warningCheckInterval);
			warningCheckInterval = null;
		}
		currentCtx = null;
	});

	pi.registerCommand("after-hours", {
		description: "Show after-hours status",
		handler: async (_args, ctx) => {
			refreshCounter();
			const inQuiet = checkQuietHours(config);
			const r = remaining();
			ctx.ui.notify(
				[
					`After-hours: ${config.enabled ? "enabled" : "disabled"}`,
					`Quiet hours: ${config.quietHoursStart} – ${config.quietHoursEnd}`,
					`Currently: ${inQuiet ? "in quiet hours" : "normal hours"}`,
					`Budget: ${r}/${config.messageLimit} remaining`,
					`Messages used tonight: ${counter.messagesUsed}`,
				].join("\n"),
				"info",
			);
		},
	});
}
