import { describe, expect, it } from "vitest";
import { stripSoftCursor } from "../src/strip.js";

const REV = "\x1b[7m";
const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const FG = "\x1b[38;2;100;100;100m";

describe("stripSoftCursor", () => {
	// --- passthrough cases ---

	it("passes plain text through unchanged", () => {
		expect(stripSoftCursor("hello world")).toBe("hello world");
	});

	it("passes empty string through", () => {
		expect(stripSoftCursor("")).toBe("");
	});

	it("returns line unchanged when reverse-on has no matching close", () => {
		expect(stripSoftCursor(`before${REV}dangling`)).toBe(`before${REV}dangling`);
	});

	it("returns line unchanged when only reset exists (no reverse-on)", () => {
		expect(stripSoftCursor(`text${RST}more`)).toBe(`text${RST}more`);
	});

	// --- basic stripping ---

	it("strips a single reverse-video span", () => {
		expect(stripSoftCursor(`before${REV}X${RST}after`)).toBe("beforeXafter");
	});

	it("strips reverse-video span with multi-char content", () => {
		expect(stripSoftCursor(`${REV}hello${RST}`)).toBe("hello");
	});

	it("strips reverse-video around a space (end-of-line cursor)", () => {
		expect(stripSoftCursor(`text${REV} ${RST}`)).toBe("text ");
	});

	it("strips reverse-video around unicode grapheme", () => {
		expect(stripSoftCursor(`${REV}🚀${RST}`)).toBe("🚀");
	});

	it("handles line with only reverse-video", () => {
		expect(stripSoftCursor(`${REV}X${RST}`)).toBe("X");
	});

	// --- last-only behavior ---

	it("strips only the last reverse-video span when multiple exist", () => {
		const input = `${REV}A${RST} gap ${REV}B${RST}`;
		expect(stripSoftCursor(input)).toBe(`${REV}A${RST} gap B`);
	});

	it("handles adjacent reverse-video spans — strips only last", () => {
		expect(stripSoftCursor(`${REV}A${RST}${REV}B${RST}`)).toBe(`${REV}A${RST}B`);
	});

	it("preserves earlier reverse-video in a line with cursor at end", () => {
		const line = `${REV}label${RST}: value${REV}X${RST}`;
		expect(stripSoftCursor(line)).toBe(`${REV}label${RST}: valueX`);
	});

	// --- interaction with other ANSI sequences ---

	it("preserves bold+reset before the cursor span", () => {
		const input = `${BOLD}bold${RST} ${REV}X${RST} plain`;
		expect(stripSoftCursor(input)).toBe(`${BOLD}bold${RST} X plain`);
	});

	it("handles a reset after the cursor span (known boundary)", () => {
		// If a \x1b[0m appears after the cursor's \x1b[0m on the same line, the
		// function matches the outer pair: last REV to last RST.  This eats the
		// inner reset and any color opener, but the visible text is preserved.
		// In practice the editor never emits color sequences after the cursor on
		// content lines, so this path doesn't fire — we test it to document the
		// boundary and confirm no text is lost.
		const input = `${REV}X${RST}${FG}colored${RST}`;
		// Strips from REV(0) to final RST — inner resets and FG become "content"
		expect(stripSoftCursor(input)).toBe(`X${RST}${FG}colored`);
	});

	it("handles color-only lines without reverse-video (border lines)", () => {
		// borderColor wraps produce \x1b[38;2;…m…\x1b[0m but no \x1b[7m
		const border = `${FG}${"─".repeat(40)}${RST}`;
		expect(stripSoftCursor(border)).toBe(border);
	});

	it("handles dim color wrapping border indicators", () => {
		const indicator = `${DIM}─── ↑ 3 more ${RST}${"─".repeat(20)}`;
		expect(stripSoftCursor(indicator)).toBe(indicator);
	});

	// --- realistic editor output ---

	it("handles content line: padding + text + cursor + padding", () => {
		// Editor renders: "  hello[cursor:w]orld        "
		const line = `  hello${REV}w${RST}orld${"  ".repeat(5)}`;
		expect(stripSoftCursor(line)).toBe(`  helloworld${"  ".repeat(5)}`);
	});

	it("handles content line: cursor at end of text + padding", () => {
		// Editor renders: "  hello[cursor: ]        "
		const line = `  hello${REV} ${RST}${"  ".repeat(5)}`;
		expect(stripSoftCursor(line)).toBe(`  hello ${"  ".repeat(5)}`);
	});

	it("handles content line with hardware cursor marker before soft cursor", () => {
		// The hardware cursor marker is a zero-width APC sequence placed before the soft cursor
		const CURSOR_MARKER = "\x1b_pi:c\x07";
		const line = `  hello${CURSOR_MARKER}${REV}w${RST}orld  `;
		expect(stripSoftCursor(line)).toBe(`  hello${CURSOR_MARKER}world  `);
	});
});
