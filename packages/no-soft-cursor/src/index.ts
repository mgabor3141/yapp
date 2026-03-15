/**
 * pi-no-soft-cursor — remove the editor's reverse-video "fake" cursor.
 *
 * This extension wraps editor rendering so it also works when other
 * extensions install their own editor component (for example
 * pi-powerline-footer), instead of relying on being the last extension to
 * replace the editor.
 */

import { CustomEditor, type ExtensionAPI, InteractiveMode } from "@mariozechner/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@mariozechner/pi-tui";

import { stripSoftCursor } from "./strip.js";

const RENDER_PATCHED = Symbol.for("pi-no-soft-cursor.render-patched");
const FACTORY_PATCHED = Symbol.for("pi-no-soft-cursor.factory-patched");
const UI_PATCHED = Symbol.for("pi-no-soft-cursor.ui-patched");
const INTERACTIVE_MODE_PATCHED = Symbol.for("pi-no-soft-cursor.interactive-mode-patched");

type Keybindings = ConstructorParameters<typeof CustomEditor>[2];
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: Keybindings) => EditorComponent;
type HardwareCursorCapable = { tui?: { setShowHardwareCursor?(show: boolean): void } };
type PatchedEditor = EditorComponent & HardwareCursorCapable & { [RENDER_PATCHED]?: boolean };
type PatchableUI = {
	[UI_PATCHED]?: boolean;
	setEditorComponent(factory: EditorFactory | undefined): void;
};

function forceHardwareCursor(editor: unknown) {
	(editor as HardwareCursorCapable | undefined)?.tui?.setShowHardwareCursor?.(true);
}

function patchEditorRender<T extends EditorComponent>(editor: T): T {
	const patchedEditor = editor as PatchedEditor;
	forceHardwareCursor(patchedEditor);
	if (patchedEditor[RENDER_PATCHED]) return editor;

	const originalRender = editor.render.bind(editor);
	patchedEditor.render = ((width: number) => {
		forceHardwareCursor(patchedEditor);
		return originalRender(width).map(stripSoftCursor);
	}) as typeof editor.render;
	patchedEditor[RENDER_PATCHED] = true;
	return editor;
}

function wrapEditorFactory(factory: EditorFactory): EditorFactory {
	const patchedFactory = factory as EditorFactory & { [FACTORY_PATCHED]?: boolean };
	if (patchedFactory[FACTORY_PATCHED]) return factory;

	const wrappedFactory: EditorFactory = (tui, theme, keybindings) =>
		patchEditorRender(factory(tui, theme, keybindings));
	(wrappedFactory as EditorFactory & { [FACTORY_PATCHED]?: boolean })[FACTORY_PATCHED] = true;
	return wrappedFactory;
}

function patchInteractiveMode() {
	const prototype = InteractiveMode.prototype as unknown as {
		[INTERACTIVE_MODE_PATCHED]?: boolean;
		setCustomEditorComponent(factory: EditorFactory | undefined): void;
	};
	if (prototype[INTERACTIVE_MODE_PATCHED]) return;

	const originalSetCustomEditorComponent = prototype.setCustomEditorComponent;
	prototype.setCustomEditorComponent = function (factory: EditorFactory | undefined) {
		return originalSetCustomEditorComponent.call(this, factory ? wrapEditorFactory(factory) : undefined);
	};
	prototype[INTERACTIVE_MODE_PATCHED] = true;
}

patchInteractiveMode();

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		const ui = ctx.ui as PatchableUI;
		if (!ui[UI_PATCHED]) {
			const originalSetEditorComponent = ui.setEditorComponent.bind(ui);
			ui.setEditorComponent = (factory: EditorFactory | undefined) =>
				originalSetEditorComponent(factory ? wrapEditorFactory(factory) : undefined);
			ui[UI_PATCHED] = true;
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			patchEditorRender(new CustomEditor(tui, theme, keybindings)),
		);
	});
}
