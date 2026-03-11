import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CounterState {
	date: string; // YYYY-MM-DD
	messagesUsed: number;
}

export function todayStr(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function stateFilePath(date = todayStr()): string {
	return join("/tmp", `pi-after-hours-${date}.json`);
}

export function loadCounter(today = todayStr()): CounterState {
	try {
		const state: CounterState = JSON.parse(readFileSync(stateFilePath(today), "utf-8"));
		if (state.date === today) return state;
	} catch {}
	return { date: today, messagesUsed: 0 };
}

export function saveCounter(state: CounterState): void {
	try {
		writeFileSync(stateFilePath(state.date), JSON.stringify(state));
	} catch {}
}
