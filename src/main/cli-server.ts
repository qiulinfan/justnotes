import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type CliAddress, type CliRequest, type CliResponse, EXIT_FAILURE, EXIT_USAGE, enterSocketDir, LineReader } from "../cli/protocol";
import { realPathOf, vaultOf } from "./ipc";

// The app's side of the `justnotes` command (src/cli/justnotes.ts): a server
// on the profile's local socket that hands each request to `dispatch` and
// writes back its answer. Electron-free, so tests drive it directly.

const MAX_REQUEST = 1 << 20;

// Starts listening, or resolves null when another live instance already
// serves this profile (the socket answers), leaving that one alone. A socket
// file nobody answers on is left from a crash and is replaced.
export async function serveCli(address: CliAddress, dispatch: (req: CliRequest) => Promise<CliResponse>): Promise<net.Server | null> {
	if (address.dir) {
		privateDir(address.dir);
		if (fs.existsSync(address.path)) {
			if (await answers(address)) return null;
			fs.rmSync(address.path, { force: true });
		}
	}
	const server = net.createServer((socket) => handle(socket, dispatch));
	const listening = new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	// Node binds a local socket synchronously inside listen(), so the folder
	// change for a long path ends before any other code runs.
	inSocketDir(address, (name) => server.listen(name));
	await listening;
	if (address.dir) fs.chmodSync(address.path, 0o600);
	return server;
}

// Closes the server and removes its socket file. libuv removes the file by
// the name it was bound with, which for a long path is relative to its folder.
export function closeCli(server: net.Server, address: CliAddress) {
	inSocketDir(address, () => server.close());
	if (address.dir) fs.rmSync(address.path, { force: true });
}

function inSocketDir(address: CliAddress, run: (name: string) => void) {
	const cwd = process.cwd();
	try {
		run(enterSocketDir(address));
	} finally {
		process.chdir(cwd);
	}
}

// The socket's folder belongs to this user and only they may enter it; a
// folder someone else owns, or a symlink in its place, is refused.
function privateDir(dir: string) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir} is not a folder`);
	if (process.getuid && stat.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
	if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function answers(address: CliAddress) {
	return new Promise<boolean>((resolve) => {
		const cwd = process.cwd();
		let socket: net.Socket;
		try {
			socket = net.connect(enterSocketDir(address));
		} finally {
			process.chdir(cwd);
		}
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

function handle(socket: net.Socket, dispatch: (req: CliRequest) => Promise<CliResponse>) {
	const reader = new LineReader(MAX_REQUEST);
	let taken = false;
	socket.setEncoding("utf8");
	socket.on("error", () => {});
	socket.on("data", async (chunk: string) => {
		if (taken) return;
		let request: unknown;
		try {
			request = reader.push(chunk);
		} catch (err) {
			taken = true;
			return reply(socket, { stdout: "", stderr: `Bad request: ${message(err)}`, code: EXIT_FAILURE });
		}
		if (request === undefined) return;
		taken = true;
		if (!isRequest(request)) return reply(socket, { stdout: "", stderr: "Bad request", code: EXIT_FAILURE });
		let response: CliResponse;
		try {
			response = await dispatch(request);
		} catch (err) {
			response = { stdout: "", stderr: message(err), code: EXIT_FAILURE };
		}
		reply(socket, response);
	});
}

function reply(socket: net.Socket, response: CliResponse) {
	if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

function isRequest(value: unknown): value is CliRequest {
	const req = value as CliRequest;
	return !!req && typeof req.cwd === "string" && Array.isArray(req.argv) && req.argv.every((arg) => typeof arg === "string");
}

function message(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

// The vault a request runs in, among the open ones (real paths). As in
// Obsidian, a leading vault= names it, by folder name or path; without one it
// is the vault holding the folder the command ran in, else `fallback` (the
// focused window's vault). Returns the rest of the arguments with it.
export function pickVault(
	argv: string[],
	cwd: string,
	open: string[],
	fallback: string | null,
): { vault: string; argv: string[] } | { error: string; code: number } {
	const spec = argv[0]?.startsWith("vault=") ? argv[0].slice("vault=".length) : null;
	const rest = spec === null ? argv : argv.slice(1);
	if (spec === null) {
		const vault = vaultOf(cwd, open) ?? fallback;
		return vault ? { vault, argv: rest } : { error: "No vault is open.", code: EXIT_FAILURE };
	}
	const named = open.filter((vault) => path.basename(vault) === spec);
	if (named.length === 1) return { vault: named[0], argv: rest };
	if (named.length > 1) return { error: `Several open vaults are named "${spec}"; give its path instead.`, code: EXIT_USAGE };
	const expanded = spec === "~" || spec.startsWith("~/") ? path.join(os.homedir(), spec.slice(1)) : spec;
	const real = realPathOf(path.resolve(cwd, expanded));
	if (open.includes(real)) return { vault: real, argv: rest };
	const names = open.map((vault) => `  ${path.basename(vault)}  ${vault}`).join("\n");
	return { error: `No open vault is "${spec}". Open vaults:\n${names}`, code: EXIT_USAGE };
}
