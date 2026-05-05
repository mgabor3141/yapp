import type { EditorComponent } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { patchEditorRender } from "../src/index.js";

const REV = "\x1b[7m";
const RST = "\x1b[0m";

type AutocompleteState = { items: string[] } | null;

interface FakeEditor extends EditorComponent {
	autocompleteState: AutocompleteState;
	tui: { setShowHardwareCursor(show: boolean): void };
	hardwareCursorCalls: boolean[];
}

function makeFakeEditor(linesProvider: () => string[]): FakeEditor {
	const editor = {
		autocompleteState: null as AutocompleteState,
		hardwareCursorCalls: [] as boolean[],
		tui: {
			setShowHardwareCursor(show: boolean) {
				editor.hardwareCursorCalls.push(show);
			},
		},
		render(_width: number) {
			return linesProvider();
		},
	} as unknown as FakeEditor;
	return editor;
}

describe("patchEditorRender", () => {
	it("strips the soft cursor when autocomplete is inactive", () => {
		const editor = makeFakeEditor(() => [`hello${REV}X${RST} `]);
		const patched = patchEditorRender(editor);

		expect(patched.render(80)).toEqual(["helloX "]);
	});

	it("preserves the soft cursor while autocomplete is active (issue #45)", () => {
		// When the file picker (`@`) is open, pi suppresses the hardware-cursor
		// marker, so the soft cursor is the only indicator. Stripping it leaves
		// the user with no visible cursor at all.
		const editor = makeFakeEditor(() => [`hello${REV}X${RST} `, "  src/index.ts"]);
		editor.autocompleteState = { items: ["src/index.ts"] };
		const patched = patchEditorRender(editor);

		expect(patched.render(80)).toEqual([`hello${REV}X${RST} `, "  src/index.ts"]);
	});

	it("forces the hardware cursor on at construction and on each render", () => {
		const editor = makeFakeEditor(() => ["text"]);
		const patched = patchEditorRender(editor);

		expect(editor.hardwareCursorCalls).toEqual([true]);
		patched.render(80);
		patched.render(80);
		expect(editor.hardwareCursorCalls).toEqual([true, true, true]);
	});

	it("is idempotent: patching the same editor twice does not double-wrap render", () => {
		let renderCount = 0;
		const editor = makeFakeEditor(() => {
			renderCount++;
			return [`a${REV}b${RST}`];
		});

		patchEditorRender(editor);
		patchEditorRender(editor);
		editor.render(80);

		expect(renderCount).toBe(1);
		// Original render was called once and stripping was applied once.
		expect(editor.render(80)).toEqual(["ab"]);
	});
});
