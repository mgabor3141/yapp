import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";

// --- Schema ---

const TimeString = v.pipe(
	v.string(),
	v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Must be a valid "HH:MM" time (00:00–23:59)'),
);

export const AfterHoursConfig = v.object({
	enabled: v.optional(v.boolean(), true),
	quietHoursStart: v.optional(TimeString, "23:00"),
	quietHoursEnd: v.optional(TimeString, "07:00"),
	messageLimit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 3),
	warningTime: v.optional(TimeString, "23:30"),
	blockMessage: v.optional(v.string(), "The agent is working. You can rest now and check results in the morning."),
});
export type AfterHoursConfig = v.InferOutput<typeof AfterHoursConfig>;

// --- Config loading ---

export function configPath(): string {
	return join(process.env.HOME ?? "~", ".pi", "agent", "extensions", "pi-after-hours.json");
}

export function loadConfig(path = configPath()): AfterHoursConfig {
	let raw: unknown = {};
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`after-hours: failed to read config at ${path}: ${err instanceof Error ? err.message : err}`);
		}
	}

	try {
		return v.parse(AfterHoursConfig, raw);
	} catch (err) {
		throw new Error(`after-hours: invalid config at ${path}: ${err instanceof Error ? err.message : err}`);
	}
}

// --- Time helpers ---

export function toMinutes(timeStr: string): number {
	const [h, m] = timeStr.split(":").map(Number);
	return h! * 60 + m!;
}

/** Check if a time (in minutes since midnight) falls within quiet hours. */
export function isInQuietHours(now: number, start: number, end: number): boolean {
	return start > end ? now >= start || now < end : now >= start && now < end;
}

/** Check if a time is past the warning threshold within quiet hours. */
export function isPastWarningTime(now: number, warn: number, end: number, inQuiet: boolean): boolean {
	if (!inQuiet) return false;
	if (now < end && warn > end) return true;
	return now >= warn;
}
