const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[0m";

/**
 * Strip the *last* reverse-video span (`\x1b[7m…\x1b[0m`) from a string,
 * keeping the inner content. Only the final occurrence is removed — this
 * targets the editor's soft cursor (which is always at the cursor position,
 * i.e. the last such span on the line) without disturbing any earlier
 * reverse-video markup.
 */
export function stripSoftCursor(line: string): string {
	const revEnd = line.lastIndexOf(REVERSE_OFF);
	if (revEnd === -1) return line;

	const revStart = line.lastIndexOf(REVERSE_ON, revEnd);
	if (revStart === -1) return line;

	// Make sure this pair is well-formed (no nested open between them)
	const contentStart = revStart + REVERSE_ON.length;
	if (contentStart > revEnd) return line;

	const before = line.slice(0, revStart);
	const content = line.slice(contentStart, revEnd);
	const after = line.slice(revEnd + REVERSE_OFF.length);

	return before + content + after;
}
