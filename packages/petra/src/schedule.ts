// The schedule of the night job (docs/ARCHITECTURE.md, section 10.1, requirement M11, decision D31).
// The cron trigger runs one time each hour. The Platform object calls sendNightJobs with the time of the tick.
// "The same day" and "the night" of an account use the time zone of the account (section 7.1).
import type { PetraStorage } from "./outbox.js";
import type { JobMessage } from "./task-work.js";

// The night job of an account runs at 02:00 local time, or at the first full hour after it.
const NIGHT_HOUR = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
// The local date of the last night job of each account, in the storage of the Platform object (section 7.3).
const LAST_NIGHT_PREFIX = "night/";

function parts(ms: number, timeZone: string): Record<string, number> {
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const values: Record<string, number> = {};
	for (const part of format.formatToParts(new Date(ms))) {
		if (part.type !== "literal") values[part.type] = Number(part.value);
	}
	return values;
}

const pad = (value: number | undefined, size = 2) => String(value ?? 0).padStart(size, "0");

// The local date (YYYY-MM-DD) and the local hour of a time in a time zone.
export function localTime(ms: number, timeZone: string): { date: string; hour: number } {
	const p = parts(ms, timeZone);
	return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, hour: p.hour ?? 0 };
}

// The difference between the local time and UTC at a time, in milliseconds.
function offset(ms: number, timeZone: string): number {
	const p = parts(ms, timeZone);
	const local = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
	return local - Math.floor(ms / 1000) * 1000;
}

// The UTC time of the start of a local date in a time zone.
export function localMidnight(date: string, timeZone: string): string {
	const guess = Date.parse(`${date}T00:00:00.000Z`);
	const first = guess - offset(guess, timeZone);
	// A second step is necessary when the offset at the result is different, for example near a clock change.
	return new Date(guess - offset(first, timeZone)).toISOString();
}

// The date before a date.
export function previousDate(date: string): string {
	return new Date(Date.parse(`${date}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

// The time a number of calendar months before a time.
export function monthsBefore(iso: string, months: number): string {
	const time = new Date(iso);
	time.setUTCMonth(time.getUTCMonth() - months);
	return time.toISOString();
}

// The command id of a night job is made from the account id and the local date. A second one does nothing.
export const nightCommandId = (accountId: string, localDate: string) => `night/${accountId}/${localDate}`;

export interface NightSchedule {
	accounts: readonly { id: string; timeZone: string }[];
	// The time of the tick, in milliseconds.
	now: number;
	storage: PetraStorage;
	send: (message: JobMessage) => Promise<void>;
}

// One tick of the schedule. For each account where the local time is 02:00 or later, and where no night job
// was sent for the local date, it puts one RunJob in the "jobs" queue and keeps the date.
export async function sendNightJobs(schedule: NightSchedule): Promise<void> {
	const at = new Date(schedule.now).toISOString();
	for (const account of schedule.accounts) {
		const local = localTime(schedule.now, account.timeZone);
		const key = `${LAST_NIGHT_PREFIX}${account.id}`;
		if (local.hour < NIGHT_HOUR || (await schedule.storage.get<string>(key)) === local.date) continue;
		const commandId = nightCommandId(account.id, local.date);
		await schedule.send({
			accountId: account.id,
			command: { type: "RunJob", commandId, at, job: "night", localDate: local.date },
		});
		// The date is kept after the send. If the send fails, the next tick sends again. A command id that comes
		// again does nothing in Petra.
		await schedule.storage.put(key, local.date);
	}
}
