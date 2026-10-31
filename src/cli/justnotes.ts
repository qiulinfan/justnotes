#!/usr/bin/env bun
// The `justnotes` command: Obsidian's CLI commands, justnotes' own, and the
// commands plugins register with registerCliHandler.
//   justnotes [--profile <dir>] [--offline] [vault=<name|path>] <command> [key=value ...] [flag ...] [--json] [--copy]
// --profile names the instance by the profile it was started with (default:
// the app's own user data folder). A running app answers over a local socket
// in that profile (protocol.ts). With none running, read-only commands read
// the vault folder themselves (offline.ts) and the others start the app for
// the vault and wait for it. --offline never asks or starts the app.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pkg from "../../package.json";
import { escapeValue, parseCliArgs } from "./args";
import { candidateLines, completeWords } from "./complete";
import { completionScript } from "./completion";
import { devElectron } from "./dev-app";
import { CliError, list, NeedsApp, render } from "./output";
import { ask, type CliAddress, type CliRequest, type CliResponse, cliAddress, defaultProfile, EXIT_FAILURE, EXIT_USAGE, enterSocketDir } from "./protocol";
import { BUILTINS, builtinHelp, type CommandSpec, flagsOf, helpText, missingReason } from "./spec";
import { pickVault, readKnownVaults } from "./vaults";

const ROOT = path.resolve(import.meta.dirname, "../..");
// How long a started app may take to answer.
const LAUNCH_WAIT = 60_000;
const RESTART_EVERY = 2000;

export interface Options {
	profile: string;
	// --profile was given, so a started app gets it too.
	ownProfile: boolean;
	offline: boolean;
	copy: boolean;
	argv: string[];
}

// Options that may come before the command; --json is the command's own flag
// and moves after it.

// Splits off the options only this command reads: --profile and --offline
// before the command, --copy anywhere (Obsidian takes it anywhere). After
// the command the other words are the command's, which may have flags of
// those names.
export function splitArgs(args: string[]): Options {
	const options: Options = { profile: defaultProfile(), ownProfile: false, offline: false, copy: false, argv: [] };
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			const value = arg === "--profile" ? args[++i] : arg.slice("--profile=".length);
			if (!value) throw new CliError("--profile needs a folder", EXIT_USAGE);
			options.profile = value;
			options.ownProfile = true;
		} else if (arg === "--offline") options.offline = true;
		else if (arg !== "--copy" && arg !== "--json") break;
	}
	options.copy = args.includes("--copy");
	options.argv = args.slice(i).filter((arg) => arg !== "--copy");
	if (args.slice(0, i).includes("--json") && options.argv.length) options.argv.push("--json");
	options.profile = path.resolve(options.profile);
	return options;
}

function notRunning(err: unknown) {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTDIR";
}

class NotRunning extends Error {}

// The app's answer, or NotRunning when no app serves the profile.
async function askApp(profile: string, request: CliRequest): Promise<CliResponse> {
	let address: CliAddress;
	try {
		address = cliAddress(profile);
	} catch {
		throw new NotRunning();
	}
	const cwd = process.cwd();
	try {
		return await ask(address, request);
	} catch (err) {
		if (notRunning(err)) throw new NotRunning();
		throw new CliError(`Could not reach justnotes: ${(err as Error).message}`);
	} finally {
		process.chdir(cwd);
	}
}

// content=- and code=- (or --content -) take stdin, byte for byte.
async function readStdinArgs(words: string[]): Promise<string[]> {
	const keys = new Set(["content", "code"]);
	const out: string[] = [];
	let stdin: string | null = null;
	const read = async () => (stdin ??= escapeValue(await readStdin()));
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const body = word.startsWith("--") ? word.slice(2) : word;
		const eq = body.indexOf("=");
		if (eq > 0 && keys.has(body.slice(0, eq)) && body.slice(eq + 1) === "-") out.push(`${body.slice(0, eq)}=${await read()}`);
		else if (word.startsWith("--") && keys.has(body) && words[i + 1] === "-") {
			out.push(`${body}=${await read()}`);
			i++;
		} else out.push(word);
	}
	return out;
}

async function readStdin() {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

// Read at build time in the packaged command (dist/cli/justnotes.mjs), from
// the checkout when run from source.
function version(): string {
	return pkg.version;
}

// The vault a command runs in when no app runs: by vault=, else the folder
// it ran in (a vault opened before, or any folder with .obsidian above it).
function localVault(options: Options, argv: string[]) {
	const picked = pickVault(argv, process.cwd(), [], readKnownVaults(options.profile), null);
	if ("error" in picked) throw new CliError(picked.error, picked.code);
	return picked;
}

// Loaded only here: reading a vault pulls in most of the app's modules, which
// a command answered by the running app does not need to load.
async function offline(spec: CommandSpec, vault: string, words: string[]) {
	const { runOffline } = await import("./offline");
	return runOffline(spec, vault, words, process.cwd(), version());
}

// How the command starts the app. Inside the packaged app the command is
// dist/cli/justnotes.mjs run by the app's own binary as Node
// (ELECTRON_RUN_AS_NODE, packaging/justnotes), so it starts that binary,
// without the variable, which would make it Node again. From source it starts
// the checkout's electron (as justnotes.app on macOS, dev-app.ts) with its
// built dist/.
function appCommand(options: Options, vault: string): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
	const args = ["--vault", vault, ...(options.ownProfile ? ["--profile", options.profile] : [])];
	if (process.versions.electron) {
		const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
		return { command: process.execPath, args, cwd: os.homedir(), env };
	}
	if (!fs.existsSync(path.join(ROOT, "dist", "main.js"))) throw new CliError(`justnotes is not built: run "bun run build" in ${ROOT}.`);
	return { command: devElectron(ROOT), args: [ROOT, ...args], cwd: ROOT, env: process.env };
}

// Starts the app for `vault` (with this profile) in the background, and waits
// until it serves the profile's socket. The app runs once per profile: a start
// while another instance holds the profile hands that instance the vault and
// exits at once, so two commands starting the app together start one. If that
// instance was quitting, the vault went nowhere and no socket comes up; a
// started app that has exited without one is started again, at most every
// RESTART_EVERY ms.
async function launch(options: Options, vault: string) {
	const { command, args, cwd, env } = appCommand(options, vault);
	let running = false;
	let startedAt = 0;
	const start = () => {
		running = true;
		startedAt = Date.now();
		const child = spawn(command, args, { cwd, env, detached: true, stdio: "ignore" });
		const exited = () => (running = false);
		child.once("exit", exited);
		child.once("error", exited);
		child.unref();
	};
	start();
	process.stderr.write(`Starting justnotes for ${vault}...\n`);
	const deadline = Date.now() + LAUNCH_WAIT;
	while (Date.now() < deadline) {
		await sleep(300);
		try {
			const address = cliAddress(options.profile);
			const cwd = process.cwd();
			const up = await new Promise<boolean>((resolve) => {
				const socket = net.connect(enterSocketDir(address));
				socket.once("connect", () => {
					socket.destroy();
					resolve(true);
				});
				socket.once("error", () => resolve(false));
			});
			process.chdir(cwd);
			if (up) return;
		} catch {}
		if (!running && Date.now() - startedAt >= RESTART_EVERY) start();
	}
	throw new CliError("justnotes did not start within a minute.");
}

function localHelp(command: string | undefined): CliResponse {
	if (!command || command === "help") return { stdout: helpText(null), stderr: "", code: 0 };
	const spec = BUILTINS.get(command);
	if (spec) return { stdout: builtinHelp(spec), stderr: "", code: 0 };
	const reason = missingReason(command);
	if (reason) return { stdout: "", stderr: reason, code: EXIT_USAGE };
	return { stdout: "", stderr: `"${command}" is no built-in command; plugin commands are listed while the app runs.`, code: EXIT_USAGE };
}

// What a command line produces.
export async function run(options: Options): Promise<CliResponse> {
	const cwd = process.cwd();
	const lead = options.argv[0]?.startsWith("vault=") ? 1 : 0;
	const command = options.argv[lead];
	const words = options.argv.slice(lead + 1);
	const spec = command === undefined ? undefined : BUILTINS.get(command);

	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		if (options.offline) return localHelp(words[0]);
		try {
			return await askApp(options.profile, { argv: [...options.argv.slice(0, lead), "help", ...words.slice(0, 1)], cwd });
		} catch (err) {
			if (err instanceof NotRunning) return localHelp(words[0]);
			throw err;
		}
	}
	if (spec?.name === "completion") {
		const shell = words.find((w) => ["zsh", "fish", "bash"].includes(w)) ?? "";
		return { stdout: completionScript(shell), stderr: "", code: 0 };
	}
	if (!spec && missingReason(command)) return { stdout: "", stderr: missingReason(command)!, code: EXIT_USAGE };

	const argv = [...options.argv.slice(0, lead + 1), ...(await readStdinArgs(words))];
	const readOnly = spec?.where === "vault";
	const request: CliRequest = { argv, cwd, read: readOnly };

	if (options.offline) {
		if (!readOnly) throw new CliError(`${command} needs the running app; --offline runs only the read-only commands (marked * in help).`, EXIT_USAGE);
		const picked = localVault(options, argv);
		try {
			return await offline(spec!, picked.vault, picked.argv.slice(1));
		} catch (err) {
			if (err instanceof NeedsApp) throw new CliError(`With --offline there is no running app for ${err.why}${err.hint ? `; ${err.hint}` : ""}.`);
			throw err;
		}
	}

	let response: CliResponse;
	try {
		response = await askApp(options.profile, request);
	} catch (err) {
		if (!(err instanceof NotRunning)) throw err;
		if (spec?.name === "vaults") return knownVaultList(options, spec, words);
		// The command comes from the same checkout or package as the app, so it knows the
		// version without a vault.
		if (spec?.name === "version" && "error" in pickVault(argv, cwd, [], readKnownVaults(options.profile), null)) return await localVersion(spec, words);
		if (spec?.name === "quit" || spec?.name === "restart") return { stdout: "", stderr: `justnotes is not running for the profile ${options.profile}.`, code: EXIT_FAILURE };
		const pickArgv = spec?.name === "vault:open" ? vaultOpenTarget(options.argv.slice(0, lead), words) : argv;
		const picked = localVault(options, pickArgv);
		if (readOnly) {
			try {
				return await offline(spec!, picked.vault, picked.argv.slice(1));
			} catch (err) {
				if (!(err instanceof NeedsApp)) throw err;
			}
		}
		await launch(options, picked.vault);
		return askApp(options.profile, { ...request, read: false });
	}
	if (response.unopened) {
		try {
			return await offline(spec!, response.unopened, argv.slice(lead + 1));
		} catch (err) {
			if (!(err instanceof NeedsApp)) throw err;
			return askApp(options.profile, { ...request, read: false });
		}
	}
	return response;
}

// With no app running every known vault is closed.
function knownVaultList(options: Options, spec: CommandSpec, words: string[]): CliResponse {
	const parsed = parseCliArgs(words, flagsOf(spec));
	if ("error" in parsed) return { stdout: "", stderr: parsed.error, code: EXIT_USAGE };
	const { params } = parsed;
	const rows = readKnownVaults(options.profile).map((v) => ({ name: path.basename(v), path: v, open: false }));
	return { stdout: render(list(params, rows, { columns: params.verbose === "true" ? ["name", "path", "open"] : ["name"] }), params), stderr: "", code: 0 };
}

// The app's modules load only here, as for offline commands.
async function localVersion(spec: CommandSpec, words: string[]): Promise<CliResponse> {
	const { apiVersion } = await import("../api/util");
	const parsed = parseCliArgs(words, flagsOf(spec));
	if ("error" in parsed) return { stdout: "", stderr: parsed.error, code: EXIT_USAGE };
	const data = { justnotes: version(), obsidianApi: apiVersion };
	return { stdout: render({ data, text: `justnotes ${data.justnotes} (Obsidian API ${data.obsidianApi})` }, parsed.params), stderr: "", code: 0 };
}

// vault:open's own name= or path=, else the leading vault=.
function vaultOpenTarget(lead: string[], words: string[]) {
	const named = words.find((w) => /^(--)?(name|path)=/.test(w));
	return named ? [`vault=${named.slice(named.indexOf("=") + 1)}`, "vault:open"] : [...lead, "vault:open"];
}

// The platform's clipboard command, for --copy.
function copy(text: string) {
	const tools: [string, string[]][] =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
						["xsel", ["--clipboard", "--input"]],
					];
	for (const [tool, args] of tools) {
		const done = spawnSync(tool, args, { input: text });
		if (!done.error && done.status === 0) return true;
	}
	return false;
}

async function main() {
	let response: CliResponse;
	let options: Options | null = null;
	// The completion scripts' hidden helper (complete.ts): candidates only,
	// never an error a shell would print mid-line.
	if (process.argv[2] === "__complete") {
		const lines = await completeWords(process.argv.slice(3), process.cwd()).then(candidateLines, () => "");
		if (lines) await new Promise<void>((done) => process.stdout.write(`${lines}\n`, () => done()));
		return 0;
	}
	try {
		options = splitArgs(process.argv.slice(2));
		response = await run(options);
	} catch (err) {
		response = { stdout: "", stderr: err instanceof Error ? err.message : String(err), code: err instanceof CliError ? err.code : EXIT_FAILURE };
	}
	if (options?.copy && response.code === 0 && response.stdout && !copy(response.stdout)) response.stderr += "Could not copy: no clipboard command found.\n";
	const write = (stream: NodeJS.WriteStream, text: string) =>
		text ? new Promise<void>((done) => stream.write(text.endsWith("\n") ? text : `${text}\n`, () => done())) : Promise.resolve();
	await write(process.stdout, response.stdout);
	await write(process.stderr, response.stderr);
	return response.code;
}

if (import.meta.main) process.exit(await main());
