import type { App } from "../api/app";
import { getElectron } from "../api/dom";
import type { CliData, CliFlags } from "../api/plugin";
import { type CliResponse, EXIT_FAILURE, EXIT_USAGE } from "../cli/protocol";

// Runs a `justnotes <command> ...` request (main/cli.ts picked this window) on
// the handlers plugins registered with registerCliHandler, with Obsidian's
// command-line syntax: key=value parameters and bare flags.

type CliHost = Pick<App, "cliHandlers">;

const USAGE = "Usage: justnotes [--profile <dir>] [vault=<name|path>] <command> [key=value ...] [flag ...]";

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
			params[body.slice(0, eq)] = unescape(body.slice(eq + 1));
			continue;
		}
		const flag = flags && Object.hasOwn(flags, body) ? flags[body] : undefined;
		const next = words[i + 1];
		if (flag?.value) {
			if (!dashed || next === undefined) return { error: `${body} needs a value: ${body}=${flag.value}` };
			params[body] = unescape(next);
			i++;
		} else if (dashed && !flag && next !== undefined && !next.startsWith("--") && !next.includes("=")) {
			params[body] = unescape(next);
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

function unescape(value: string) {
	return value.replace(/\\([nt\\])/g, (_, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : "\\"));
}

// The command list, or one command's flags.
export function cliHelp(host: CliHost, command?: string): CliResponse {
	if (command && command !== "help") {
		const entry = host.cliHandlers.get(command);
		if (!entry) return unknown(command);
		const lines = [`${command}  (${entry.pluginId})`, entry.description];
		const flags = Object.entries(entry.flags ?? {});
		if (flags.length) {
			lines.push("", "Flags:");
			lines.push(
				...columns(flags.map(([key, flag]) => [flag.value ? `${key}=${flag.value}` : key, flag.description + (flag.required ? " (required)" : "")])),
			);
		}
		return { stdout: lines.join("\n"), stderr: "", code: 0 };
	}
	const rows: [string, string][] = [["help [<command>]", "List the commands, or show one command's flags"]];
	for (const [name, entry] of [...host.cliHandlers].sort(([a], [b]) => a.localeCompare(b))) rows.push([name, entry.description]);
	return { stdout: [USAGE, "", "Commands:", ...columns(rows)].join("\n"), stderr: "", code: 0 };
}

function columns(rows: [string, string][]) {
	const width = Math.max(...rows.map(([left]) => left.length));
	return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

function unknown(command: string): CliResponse {
	return { stdout: "", stderr: `Unknown command "${command}". Run "justnotes help" for the list.`, code: EXIT_USAGE };
}

export async function runCli(host: CliHost, argv: string[]): Promise<CliResponse> {
	const [command, ...words] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") return cliHelp(host, words[0]);
	const entry = host.cliHandlers.get(command);
	if (!entry) return unknown(command);
	const parsed = parseCliArgs(words, entry.flags);
	if ("error" in parsed) return { stdout: "", stderr: `${parsed.error}\nRun "justnotes help ${command}" for its flags.`, code: EXIT_USAGE };
	try {
		const output = await entry.handler(parsed.params);
		return { stdout: output == null ? "" : String(output), stderr: "", code: 0 };
	} catch (err) {
		console.error(`CLI command ${command} failed`, err);
		return { stdout: "", stderr: err instanceof Error ? err.message : String(err), code: EXIT_FAILURE };
	}
}

// Takes requests from main once plugins have loaded and registered their
// handlers.
export function installCli(app: App) {
	const { ipcRenderer } = getElectron();
	ipcRenderer.on("justnotes:cli", async (_evt: unknown, id: number, argv: string[]) => {
		ipcRenderer.send("justnotes:cli-result", id, await runCli(app, argv));
	});
	ipcRenderer.send("justnotes:cli-ready");
}
