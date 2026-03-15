/**
 * pi-no-soft-cursor — remove the editor's reverse-video "fake" cursor.
 *
 * The terminal's native (hardware) cursor is forced on so you still see
 * a blinking caret at the insertion point. Only the highlighted block that
 * the editor draws on top is removed.
 *
 * Note: with this extension active, pi's "Show hardware cursor" setting
 * has no effect — the hardware cursor is always enabled.
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { stripSoftCursor } from "./strip.js";

class NoCursorEditor extends CustomEditor {
	constructor(...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
		this.tui.setShowHardwareCursor(true);
	}

	render(width: number): string[] {
		return super.render(width).map(stripSoftCursor);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, kb) => new NoCursorEditor(tui, theme, kb));
	});
}
