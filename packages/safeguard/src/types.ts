export interface VerdictData {
	action: string;
	verdict: "approve" | "deny" | "ask" | "user-approve" | "user-deny" | "error";
	reason: string;
}

export interface Verdict {
	verdict: "approve" | "deny" | "ask";
	reason: string;
	guidance: string;
}

export interface CustomEntryTyped<T> {
	type: "custom";
	customType: string;
	data: T;
}

export function isCustomEntry<T>(entry: { type: string }, customType: string): entry is CustomEntryTyped<T> {
	// biome-ignore lint/suspicious/noExplicitAny: untyped session entry
	return entry.type === "custom" && (entry as any).customType === customType;
}
