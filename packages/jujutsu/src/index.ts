import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JjInfo {
	empty: boolean;
	description: string;
	bookmarks: string[];
	changeShort: string;
}

interface WcStats {
	fileLines: string[];
	summaryLine: string;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let isJjRepo = false;
	let branchLabel: string | null = null;
	let patched = false;
	let jjRoot: string | null = null;
	let agentActive = false;
	let opWatcher: FSWatcher | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// -----------------------------------------------------------------------
	// jj helpers
	// -----------------------------------------------------------------------

	async function detectJj(): Promise<void> {
		const result = await pi.exec("jj", ["root"], { timeout: 3000 });
		isJjRepo = result.code === 0;
		jjRoot = isJjRepo ? result.stdout.trim() : null;
	}

	async function queryRev(rev: string): Promise<JjInfo | null> {
		const result = await pi.exec(
			"jj",
			[
				"--ignore-working-copy",
				"log",
				"--no-graph",
				"-r",
				rev,
				"-T",
				'if(empty, "E", "M") ++ "\\n" ++ description.first_line() ++ "\\n" ++ bookmarks.join(",") ++ "\\n" ++ change_id.shortest()',
			],
			{ timeout: 3000 },
		);
		if (result.code !== 0) return null;
		const lines = result.stdout.split("\n");
		return {
			empty: lines[0] === "E",
			description: lines[1] ?? "",
			bookmarks: (lines[2] ?? "").split(",").filter(Boolean),
			changeShort: lines[3] ?? "",
		};
	}

	async function getStackDepth(): Promise<number> {
		const result = await pi.exec(
			"jj",
			["--ignore-working-copy", "log", "--no-graph", "-r", "::@ & mutable()", "-T", "'.'\n"],
			{ timeout: 3000 },
		);
		if (result.code !== 0) return 0;
		return result.stdout.split("\n").filter(Boolean).length;
	}

	async function snapshot(): Promise<boolean> {
		const result = await pi.exec("jj", ["util", "snapshot"], { timeout: 10000 });
		return result.code === 0;
	}

	/** Get working copy diff stat (@ vs @-). Respects terminal width via COLUMNS. */
	async function getWcStat(columns?: number): Promise<WcStats | null> {
		const cmd = columns ? "env" : "jj";
		const args = columns ? [`COLUMNS=${columns}`, "jj", "diff", "--stat"] : ["diff", "--stat"];
		const result = await pi.exec(cmd, args, { timeout: 10000 });
		if (result.code !== 0) return null;

		const lines = result.stdout.split("\n").filter(Boolean);
		if (lines.length === 0) return null;

		const summaryLine = lines[lines.length - 1];
		if (!summaryLine.match(/\d+ files? changed/)) return null;

		return {
			fileLines: lines.slice(0, -1),
			summaryLine,
		};
	}

	// -----------------------------------------------------------------------
	// Footer label
	// -----------------------------------------------------------------------

	function labelFor(info: JjInfo): string {
		if (info.bookmarks.length > 0) return info.bookmarks[0];
		if (info.description) return info.description;
		return info.changeShort;
	}

	async function refreshLabel(): Promise<void> {
		if (!isJjRepo) {
			branchLabel = null;
			return;
		}
		try {
			const at = await queryRev("@");
			if (!at) {
				branchLabel = null;
				return;
			}

			let label: string;
			if (at.empty && !at.description) {
				const parent = await queryRev("@-");
				label = parent ? labelFor(parent) : labelFor(at);
			} else {
				label = labelFor(at);
			}

			const depth = await getStackDepth();
			branchLabel = depth > 1 ? `${label} [${depth}]` : label;
		} catch {
			branchLabel = null;
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: pi-tui types not importable from extensions
	function patchFooter(ctx: { hasUI: boolean; ui: any }) {
		if (!ctx.hasUI || patched) return;

		// biome-ignore lint/suspicious/noExplicitAny: pi-tui types not importable from extensions
		ctx.ui.setFooter((_tui: any, _theme: any, footerData: any) => {
			const original = footerData.getGitBranch.bind(footerData);
			footerData.getGitBranch = () => {
				const branch = original();
				return branch === "detached" && branchLabel ? branchLabel : branch;
			};
			patched = true;
			return { render: () => [], dispose() {} };
		});
		ctx.ui.setFooter(undefined);
	}

	// -----------------------------------------------------------------------
	// Widget
	// -----------------------------------------------------------------------

	const WIDGET_KEY = "jj-diff";
	const MAX_FILE_LINES = 8;
	const WIDGET_PADDING = 1; // 1-char left padding in render()

	// biome-ignore lint: simple ANSI strip for width measurement
	const ANSI_RE = /\x1b\[[0-9;]*m/g;

	function visibleLen(s: string): number {
		return s.replace(ANSI_RE, "").length;
	}

	/** Truncate an ANSI-colored string to maxWidth visible characters. */
	function truncate(s: string, maxWidth: number): string {
		let visible = 0;
		let i = 0;
		while (i < s.length && visible < maxWidth) {
			if (s[i] === "\x1b") {
				// Skip ANSI escape sequence
				const end = s.indexOf("m", i);
				i = end === -1 ? s.length : end + 1;
			} else {
				visible++;
				i++;
			}
		}
		return `${s.slice(0, i)}\x1b[0m`;
	}

	type ThemeFg = { fg(color: string, text: string): string };

	/** Colorize a stat file line: green for +, red for - in the bar portion. */
	function colorizeFileLine(line: string, theme: ThemeFg): string {
		return line
			.replace(/([+]+)/g, (m) => theme.fg("toolDiffAdded", m))
			.replace(/([-]+)/g, (m) => theme.fg("toolDiffRemoved", m));
	}

	/** Colorize the summary line: green for insertions, red for deletions. */
	function colorizeSummaryLine(line: string, theme: ThemeFg): string {
		return line
			.replace(/(\d+ insertions?\(\+\))/, (m) => theme.fg("toolDiffAdded", m))
			.replace(/(\d+ deletions?\(-\))/, (m) => theme.fg("toolDiffRemoved", m));
	}

	function buildLines(wc: WcStats, theme: ThemeFg): string[] {
		const lines: string[] = [];

		if (wc.fileLines.length <= MAX_FILE_LINES) {
			for (const fl of wc.fileLines) lines.push(colorizeFileLine(fl, theme));
		} else {
			for (const fl of wc.fileLines.slice(0, MAX_FILE_LINES - 1)) lines.push(colorizeFileLine(fl, theme));
			const hidden = wc.fileLines.length - (MAX_FILE_LINES - 1);
			lines.push(theme.fg("muted", `  ... and ${hidden} more file${hidden === 1 ? "" : "s"}`));
		}

		lines.push(colorizeSummaryLine(wc.summaryLine, theme));
		return lines;
	}

	function showWidget(ctx: ExtensionContext, wc: WcStats): void {
		if (!ctx.hasUI) return;
		// biome-ignore lint/suspicious/noExplicitAny: pi-tui types not importable from extensions
		ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: ThemeFg) => {
			let lines = buildLines(wc, theme);
			let renderedWidth = 0;
			let refreshing = false;

			return {
				render(width: number): string[] {
					if (renderedWidth && renderedWidth !== width && !refreshing) {
						refreshing = true;
						getWcStat(width - WIDGET_PADDING).then((newWc) => {
							if (newWc) {
								lines = buildLines(newWc, theme);
							}
							renderedWidth = width;
							refreshing = false;
							showWidget(ctx, newWc ?? wc);
						});
					}
					renderedWidth = width;
					return lines.map((l) => {
						const padded = ` ${l}`;
						return visibleLen(padded) > width ? truncate(padded, width) : padded;
					});
				},
				invalidate() {},
			};
		});
	}

	function clearWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/** Snapshot working copy and update widget with current @ diff stat. */
	async function refreshWidget(ctx: ExtensionContext): Promise<void> {
		if (!isJjRepo) return;

		const ok = await snapshot();
		if (!ok) {
			if (ctx.hasUI) ctx.ui.notify("pi-jj: snapshot failed", "error");
			return;
		}

		const wc = await getWcStat();
		if (!wc) {
			clearWidget(ctx);
			return;
		}

		showWidget(ctx, wc);
	}

	// -----------------------------------------------------------------------
	// Op watcher (detect external jj operations)
	// -----------------------------------------------------------------------

	function stopWatcher(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (opWatcher) {
			opWatcher.close();
			opWatcher = null;
		}
	}

	function startWatcher(ctx: ExtensionContext): void {
		stopWatcher();
		if (!jjRoot) return;

		const opHeadsDir = join(jjRoot, ".jj", "repo", "op_heads", "heads");
		try {
			opWatcher = watch(opHeadsDir, () => {
				// Debounce: a single jj op removes old + adds new head file
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(async () => {
					debounceTimer = null;
					// Skip refresh while agent is running (it snapshots at turn_end)
					if (agentActive) return;
					await refreshLabel();
					patchFooter(ctx);
					await refreshWidget(ctx);
				}, 200);
			});
			// Don't let the watcher keep the process alive
			opWatcher.unref();
		} catch {
			// Directory might not exist (non-standard jj layout); silently skip
			opWatcher = null;
		}
	}

	// -----------------------------------------------------------------------
	// Event handlers
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		await detectJj();
		if (!isJjRepo) return;
		await refreshLabel();
		patchFooter(ctx);
		await refreshWidget(ctx);
		startWatcher(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		stopWatcher();
		patched = false;
		await detectJj();
		if (!isJjRepo) return;
		await refreshLabel();
		patchFooter(ctx);
		await refreshWidget(ctx);
		startWatcher(ctx);
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!isJjRepo) return;
		agentActive = true;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!isJjRepo) return;
		await refreshWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isJjRepo) return;
		agentActive = false;
		await refreshWidget(ctx);
		await refreshLabel();
		patchFooter(ctx);
	});
}
