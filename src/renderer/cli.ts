import type { App } from "../api/app";
import { getElectron } from "../api/dom";
import { parseCliArgs } from "../cli/args";
import { APP_COMMANDS } from "../cli/commands/app";
import type { Ctx } from "../cli/commands/context";
import { VAULT_COMMANDS } from "../cli/commands/vault";
import { type CliResponse, EXIT_FAILURE, EXIT_USAGE } from "../cli/protocol";
import { runBuiltin } from "../cli/run";
import { BUILTINS, builtinHelp, commandHelp, helpText, missingReason } from "../cli/spec";

// Runs a `justnotes <command> ...` request (main/cli.ts picked this window):
// a built-in command (src/cli/spec.ts), else a handler a plugin registered
// with registerCliHandler, with Obsidian's command-line syntax.

type CliHost = Pick<App, "cliHandlers">;

function pluginCommands(host: CliHost) {
	return [...host.cliHandlers].map(([name, entry]) => ({ name, description: entry.description, pluginId: entry.pluginId, flags: entry.flags }));
}

// The command list, or one command's flags.
export function cliHelp(host: CliHost, command?: string): CliResponse {
	if (!command || command === "help") return { stdout: helpText(pluginCommands(host)), stderr: "", code: 0 };
	const spec = BUILTINS.get(command);
	if (spec) return { stdout: builtinHelp(spec), stderr: "", code: 0 };
	const entry = host.cliHandlers.get(command);
	if (entry) return { stdout: commandHelp(command, entry.description, entry.flags, entry.pluginId), stderr: "", code: 0 };
	return unknown(command);
}

function unknown(command: string): CliResponse {
	const reason = missingReason(command);
	return { stdout: "", stderr: reason ?? `Unknown command "${command}". Run "justnotes help" for the list.`, code: EXIT_USAGE };
}

function version() {
	try {
		return getElectron().remote.app.getVersion();
	} catch {
		return "";
	}
}

const CLEAN_WAIT = 5000;

function cleanCache(app: App) {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, CLEAN_WAIT);
		app.metadataCache.onCleanCache(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

export async function runCli(host: CliHost, argv: string[], cwd = "/"): Promise<CliResponse> {
	const [command, ...words] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") return cliHelp(host, words[0]);
	const spec = BUILTINS.get(command);
	if (spec) {
		const handler = VAULT_COMMANDS[command] ?? APP_COMMANDS[command];
		if (!handler) return { stdout: "", stderr: `"${command}" runs in the justnotes command, not in the app.`, code: EXIT_USAGE };
		const app = host as App;
		const ctx: Ctx = { app, live: true, version: version(), cwd };
		// Commands read the metadata cache, and the next command should see
		// what this one wrote: both wait until changes so far are indexed.
		await cleanCache(app);
		const response = await runBuiltin(spec, handler, ctx, words);
		await cleanCache(app);
		return response;
	}
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
	ipcRenderer.on("justnotes:cli", async (_evt: unknown, id: number, argv: string[], cwd: string) => {
		ipcRenderer.send("justnotes:cli-result", id, await runCli(app, argv, cwd));
	});
	ipcRenderer.send("justnotes:cli-ready");
}
