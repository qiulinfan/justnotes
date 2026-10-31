import type { CliData, CliFlags } from "../api/plugin";

// Obsidian's command-line syntax, shared by the app (renderer/cli.ts) and the
// command when it reads a vault itself (offline.ts).

// Turns the words after the command into the handler's params. key=value and
// --key=value set a value and a bare flag is "true", as in Obsidian. --key
// <value> takes the next word for a flag declared with a value, and for an
// undeclared key when that word is neither --x nor x=y; a declared switch, or
// --key with nothing to take, is "true". In values, \n is a
// newline, \t a tab and \\ a backslash, as in Obsidian. Undeclared keys pass
// through: QuickAdd reads value-<id>=... and other keys as its variables.
export function parseCliArgs(words: string[], flags: CliFlags | null): { params: CliData } | { error: string } {
	const params: CliData = {};
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const dashed = word.startsWith("--");
		const body = dashed ? word.slice(2) : word;
		const eq = body.indexOf("=");
		if (eq === 0 || !body) return { error: `"${word}" names no flag.` };
		if (eq > 0) {
			params[body.slice(0, eq)] = unescapeValue(body.slice(eq + 1));
			continue;
		}
		const flag = flags && Object.hasOwn(flags, body) ? flags[body] : undefined;
		const next = words[i + 1];
		if (flag?.value) {
			if (!dashed || next === undefined) return { error: `${body} needs a value: ${body}=${flag.value}` };
			params[body] = unescapeValue(next);
			i++;
		} else if (dashed && !flag && next !== undefined && !next.startsWith("--") && !next.includes("=")) {
			params[body] = unescapeValue(next);
			i++;
		} else {
			params[body] = "true";
		}
	}
	const missing = Object.entries(flags ?? {})
		.filter(([key, flag]) => flag.required && !(key in params))
		.map(([key, flag]) => (flag.value ? `${key}=${flag.value}` : key));
	if (missing.length) return { error: `Missing required ${missing.length > 1 ? "flags" : "flag"}: ${missing.join(" ")}` };
	return { params };
}

export function unescapeValue(value: string) {
	return value.replace(/\\([nt\\])/g, (_, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : "\\"));
}

// The inverse for a value that must arrive byte for byte (stdin given as
// content=-): only backslashes need escaping for unescapeValue to undo.
export function escapeValue(value: string) {
	return value.replace(/\\/g, "\\\\");
}
