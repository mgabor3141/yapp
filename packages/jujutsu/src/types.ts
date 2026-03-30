export interface JjInfo {
	empty: boolean;
	description: string;
	bookmarks: string[];
	changeShort: string;
}

export interface WcStats {
	fileLines: string[];
	summaryLine: string;
}

export type ThemeFg = { fg(color: string, text: string): string };
