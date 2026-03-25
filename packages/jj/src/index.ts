import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface JjInfo {
	empty: boolean;
	description: string;
	bookmarks: string[];
	changeShort: string;
}

export default function (pi: ExtensionAPI) {
	let isJjRepo = false;
	let branchLabel: string | null = null;
	let patched = false;

	async function detectJj(): Promise<void> {
		const result = await pi.exec("jj", ["root"], { timeout: 3000 });
		isJjRepo = result.code === 0;
	}

	async function queryRev(rev: string): Promise<JjInfo | null> {
		const result = await pi.exec("jj", [
			"--ignore-working-copy",
			"log", "--no-graph", "-r", rev,
			"-T", 'if(empty, "E", "M") ++ "\\n" ++ description.first_line() ++ "\\n" ++ bookmarks.join(",") ++ "\\n" ++ change_id.shortest()',
		], { timeout: 3000 });
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
		const result = await pi.exec("jj", [
			"--ignore-working-copy",
			"log", "--no-graph", "-r", "::@ & mutable()",
			"-T", "'.'\n",
		], { timeout: 3000 });
		if (result.code !== 0) return 0;
		return result.stdout.split("\n").filter(Boolean).length;
	}

	function labelFor(info: JjInfo): string {
		if (info.bookmarks.length > 0) return info.bookmarks[0];
		if (info.description) return info.description;
		return info.changeShort;
	}

	async function refreshLabel(): Promise<void> {
		if (!isJjRepo) { branchLabel = null; return; }
		try {
			const at = await queryRev("@");
			if (!at) { branchLabel = null; return; }

			let label: string;

			// If @ is empty with no description, show @- instead
			if (at.empty && !at.description) {
				const parent = await queryRev("@-");
				label = parent ? labelFor(parent) : labelFor(at);
			} else {
				label = labelFor(at);
			}

			const depth = await getStackDepth();
			branchLabel = depth > 1 ? `jj: ${label} [${depth}]` : `jj: ${label}`;
		} catch {
			branchLabel = null;
		}
	}

	/**
	 * Patch the shared footerData provider so the built-in footer shows
	 * our jj label instead of "detached". Briefly installs a custom footer
	 * to grab the footerData reference, patches getGitBranch, then
	 * immediately restores the built-in footer.
	 */
	function patchFooter(ctx: { hasUI: boolean; ui: any }) {
		if (!ctx.hasUI || patched) return;

		ctx.ui.setFooter((_tui: any, _theme: any, footerData: any) => {
			const original = footerData.getGitBranch.bind(footerData);
			footerData.getGitBranch = () => {
				const branch = original();
				return (branch === "detached" && branchLabel) ? branchLabel : branch;
			};
			patched = true;
			return { render: () => [], dispose() {} };
		});

		// Restore the built-in footer with the patched provider
		ctx.ui.setFooter(undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		await detectJj();
		if (!isJjRepo) return;
		await refreshLabel();
		patchFooter(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		patched = false;
		await detectJj();
		if (!isJjRepo) return;
		await refreshLabel();
		patchFooter(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isJjRepo) return;
		await refreshLabel();
		patchFooter(ctx);
	});
}
