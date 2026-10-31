import { inspect } from "node:util";

// The vault window's console messages and uncaught errors, kept for
// `justnotes dev:console` and `dev:errors`. Installed first thing at boot,
// so plugin output counts; the console still prints everything as before.

export interface ConsoleEntry {
	level: string;
	time: number;
	text: string;
}

const LIMIT = 1000;
export const consoleEntries: ConsoleEntry[] = [];
export const errorEntries: ConsoleEntry[] = [];

function push(buffer: ConsoleEntry[], entry: ConsoleEntry) {
	buffer.push(entry);
	if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);
}

function describe(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
	try {
		return inspect(value, { depth: 3, breakLength: Number.POSITIVE_INFINITY });
	} catch {
		return String(value);
	}
}

export function installDevCapture(win: Window & typeof globalThis = window) {
	const target = win.console as unknown as Record<string, (...args: unknown[]) => void>;
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		const original = target[level];
		target[level] = (...args: unknown[]) => {
			push(consoleEntries, { level, time: Date.now(), text: args.map(describe).join(" ") });
			original.apply(win.console, args);
		};
	}
	win.addEventListener("error", (evt) => push(errorEntries, { level: "error", time: Date.now(), text: evt.error ? describe(evt.error) : evt.message }));
	win.addEventListener("unhandledrejection", (evt) => push(errorEntries, { level: "error", time: Date.now(), text: `Unhandled rejection: ${describe(evt.reason)}` }));
}
