#!/usr/bin/env bun
// The `justnotes` command: runs a command a plugin registered with
// registerCliHandler in the running app and prints its output.
//   justnotes [--profile <dir>] [vault=<name|path>] <command> [key=value ...] [flag ...]
//   justnotes help [<command>]
// --profile names the instance by the profile it was started with (default:
// the app's own user data folder). The app answers over a local socket in
// that profile (protocol.ts); with no app running this says so and exits 1.
import * as net from "node:net";
import * as path from "node:path";
import { type CliAddress, type CliResponse, cliAddress, defaultProfile, EXIT_FAILURE, enterSocketDir, LineReader } from "./protocol";

const MAX_RESPONSE = 64 << 20;

// Splits off a leading --profile, which only this command reads; after the
// command the words are the handler's, which may have a flag of that name.
export function splitArgs(args: string[]): { profile: string; argv: string[] } {
	let profile = defaultProfile();
	let i = 0;
	if (args[0] === "--profile") {
		if (!args[1]) throw new Error("--profile needs a folder");
		profile = args[1];
		i = 2;
	} else if (args[0]?.startsWith("--profile=")) {
		profile = args[0].slice("--profile=".length);
		if (!profile) throw new Error("--profile needs a folder");
		i = 1;
	}
	return { profile: path.resolve(profile), argv: args.slice(i) };
}

// Sends one request and resolves with the app's answer, or rejects with the
// connection error (ENOENT or ECONNREFUSED: no app serves this profile).
export function ask(address: CliAddress, argv: string[], cwd: string): Promise<CliResponse> {
	return new Promise((resolve, reject) => {
		const reader = new LineReader(MAX_RESPONSE);
		const socket = net.connect(enterSocketDir(address));
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ argv, cwd })}\n`));
		socket.on("data", (chunk: string) => {
			try {
				const response = reader.push(chunk) as CliResponse | undefined;
				if (response === undefined) return;
				resolve(response);
				socket.end();
			} catch (err) {
				reject(err);
				socket.destroy();
			}
		});
		socket.on("error", reject);
		socket.on("close", () => reject(new Error("The app closed the connection without an answer.")));
	});
}

function notRunning(err: unknown) {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

async function main() {
	const cwd = process.cwd();
	let profile: string;
	let argv: string[];
	try {
		({ profile, argv } = splitArgs(process.argv.slice(2)));
	} catch (err) {
		process.stderr.write(`${(err as Error).message}\n`);
		return 2;
	}
	let address: CliAddress;
	try {
		address = cliAddress(profile);
	} catch {
		process.stderr.write(`justnotes is not running (no profile at ${profile}).\n`);
		return EXIT_FAILURE;
	}
	let response: CliResponse;
	try {
		response = await ask(address, argv, cwd);
	} catch (err) {
		process.stderr.write(
			notRunning(err) ? `justnotes is not running for the profile ${profile}.\n` : `Could not reach justnotes: ${(err as Error).message}\n`,
		);
		return EXIT_FAILURE;
	}
	const write = (stream: NodeJS.WriteStream, text: string) =>
		text ? new Promise<void>((done) => stream.write(text.endsWith("\n") ? text : `${text}\n`, () => done())) : Promise.resolve();
	await write(process.stdout, response.stdout);
	await write(process.stderr, response.stderr);
	return response.code;
}

if (import.meta.main) process.exit(await main());
