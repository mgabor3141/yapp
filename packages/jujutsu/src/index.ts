import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildWidgetLines, formatParentOneLiner, labelFor, truncate, visibleLen } from "./format.js";
import type { JjInfo, ThemeFg, WcStats } from "./types.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let isJjRepo = false;
	let branchLabel: string | null = null;
	let patched = false;
	let jjRoot: string | null = null;
	let agentActive = false;
	let widgetVisible = true;
	let lastWidgetCtx: ExtensionContext | null = null;
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

	/** Get diff stat for a revision. Defaults to @ (working copy). Respects terminal width via COLUMNS. */
	async function getDiffStat(rev?: string, columns?: number): Promise<WcStats | null> {
		const jjArgs = rev ? ["diff", "-r", rev, "--stat"] : ["diff", "--stat"];
		const cmd = columns ? "env" : "jj";
		const args = columns ? [`COLUMNS=${columns}`, "jj", ...jjArgs] : jjArgs;
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

			const label = labelFor(at);
			const depth = await getStackDepth();
			const base = depth > 1 ? `${label} [${depth}]` : label;
			branchLabel = at.empty ? `empty: ${base}` : base;
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
	const WIDGET_OPTIONS = { placement: "belowEditor" } as const;
	const WIDGET_PADDING = 1; // 1-char left padding in render()

	/** Show widget. `rev` controls which revision to re-fetch on resize (undefined = @). */
	function showWidget(ctx: ExtensionContext, wc: WcStats, rev?: string): void {
		lastWidgetCtx = ctx;
		if (!ctx.hasUI || !widgetVisible) return;
		// biome-ignore lint/suspicious/noExplicitAny: pi-tui types not importable from extensions
		ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: ThemeFg) => {
			let lines = buildWidgetLines(wc, theme);
			let renderedWidth = 0;
			let refreshing = false;

			return {
				render(width: number): string[] {
					if (renderedWidth && renderedWidth !== width && !refreshing) {
						refreshing = true;
						getDiffStat(rev, width - WIDGET_PADDING)
							.then((newWc) => {
								if (newWc) {
									lines = buildWidgetLines(newWc, theme);
								}
								renderedWidth = width;
								refreshing = false;
								showWidget(ctx, newWc ?? wc, rev);
							})
							.catch(() => {
								refreshing = false;
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
		}, WIDGET_OPTIONS);
	}

	/** Show a compact one-liner widget (used when @ is empty). */
	function showOneLiner(ctx: ExtensionContext, description: string, summaryLine: string): void {
		lastWidgetCtx = ctx;
		if (!ctx.hasUI || !widgetVisible) return;
		// biome-ignore lint/suspicious/noExplicitAny: pi-tui types not importable from extensions
		ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: ThemeFg) => {
			const line = formatParentOneLiner(description, summaryLine, theme);
			return {
				render(width: number): string[] {
					const padded = ` ${line}`;
					return [visibleLen(padded) > width ? truncate(padded, width) : padded];
				},
				invalidate() {},
			};
		}, WIDGET_OPTIONS);
	}

	function clearWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/** Snapshot working copy, then update widget with current @ diff stat. */
	async function snapshotAndRefreshWidget(ctx: ExtensionContext): Promise<void> {
		if (!isJjRepo) return;

		const ok = await snapshot();
		if (!ok) {
			if (ctx.hasUI) ctx.ui.notify("pi-jujutsu: snapshot failed", "error");
			return;
		}

		await refreshWidget(ctx);
	}

	/** Update widget with current @ diff stat, falling back to @- one-liner if @ is empty. */
	async function refreshWidget(ctx: ExtensionContext): Promise<void> {
		if (!isJjRepo) return;

		// Try @ first
		const wc = await getDiffStat();
		if (wc) {
			showWidget(ctx, wc);
			return;
		}

		// @ is empty; show @- as a compact one-liner
		const parent = await queryRev("@-");
		const parentStat = await getDiffStat("@-");
		if (parent && parentStat) {
			const desc = parent.description || parent.changeShort;
			showOneLiner(ctx, desc, parentStat.summaryLine);
			return;
		}

		clearWidget(ctx);
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
		await snapshotAndRefreshWidget(ctx);
		startWatcher(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		stopWatcher();
		patched = false;
		await detectJj();
		if (!isJjRepo) return;
		await refreshLabel();
		patchFooter(ctx);
		await snapshotAndRefreshWidget(ctx);
		startWatcher(ctx);
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!isJjRepo) return;
		agentActive = true;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!isJjRepo) return;
		await snapshotAndRefreshWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isJjRepo) return;
		agentActive = false;
		await snapshotAndRefreshWidget(ctx);
		await refreshLabel();
		patchFooter(ctx);
	});

	// -----------------------------------------------------------------------
	// Shortcut: toggle widget visibility
	// -----------------------------------------------------------------------

	pi.registerShortcut("ctrl+shift+j", {
		description: "Toggle jj working copy widget",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			if (widgetVisible && lastWidgetCtx) {
				await refreshWidget(lastWidgetCtx);
			} else {
				clearWidget(ctx);
			}
		},
	});
}
