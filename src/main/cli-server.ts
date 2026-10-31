import * as fs from "node:fs";
import * as net from "node:net";
import { type CliAddress, type CliRequest, type CliResponse, EXIT_FAILURE, enterSocketDir, LineReader, privateDir } from "../cli/protocol";

// The app's side of the `justnotes` command (src/cli/justnotes.ts): a server
// on the profile's local socket that hands each request to `dispatch` and
// writes back its answer. Electron-free, so tests drive it directly.

// Room for a note read from stdin (content=-).
const MAX_REQUEST = 32 << 20;

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
	return (
		!!req &&
		typeof req.cwd === "string" &&
		Array.isArray(req.argv) &&
		req.argv.every((arg) => typeof arg === "string") &&
		(req.read === undefined || typeof req.read === "boolean") &&
		(req.complete === undefined || typeof req.complete === "boolean")
	);
}

function message(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}
