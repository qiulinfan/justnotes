import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// The `justnotes` command talks to the running app over a local socket: one
// JSON line from the command, one JSON line back, then the app closes the
// connection. Nothing listens on the network.

// What the command sends: its arguments after the global options, and the
// folder it ran in (it picks the vault when no vault= is given). `read`
// marks a command that can read the vault folder itself: the app runs it
// only in a vault it shows, and otherwise answers with `unopened` instead of
// opening a window. `complete` asks, for shell completion, which plugin
// commands the vault named by `argv` (only a leading vault=) has registered:
// the app runs nothing, opens no window and waits for none, and answers a
// CompletionAnswer as JSON.
export interface CliRequest {
	argv: string[];
	cwd: string;
	read?: boolean;
	complete?: boolean;
}

// What the app answers: text for stdout and stderr, and the exit status.
export interface CliResponse {
	stdout: string;
	stderr: string;
	code: number;
	// The vault a `read` request named, which no window shows.
	unopened?: string;
}

// Exit statuses: a handler that threw, or no app to ask, is 1; a command line
// the app could not run (unknown command, missing or empty flag, unknown
// vault) is 2.
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

// Electron's default user data folder for this app (its name in package.json),
// the profile an instance started without --profile uses.
export function defaultProfile(): string {
	const home = os.homedir();
	if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "justnotes");
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "justnotes");
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "justnotes");
}

// Where an instance using `profile` listens. On macOS and Linux the socket is
// in a folder of the profile only its owner may enter, so no other user can
// connect; on Windows a named pipe keyed by the profile's path.
export interface CliAddress {
	dir: string | null;
	path: string;
}

export function cliAddress(profile: string): CliAddress {
	const real = fs.realpathSync(profile);
	if (process.platform === "win32") {
		const key = crypto.createHash("sha256").update(real.toLowerCase()).digest("hex").slice(0, 16);
		return { dir: null, path: `\\\\.\\pipe\\justnotes-${key}` };
	}
	const dir = path.join(real, "cli");
	return { dir, path: path.join(dir, SOCKET_NAME) };
}

export const SOCKET_NAME = "justnotes-cli.sock";

// The plugin commands each vault's window last registered, which the app
// keeps for completion while no app runs (complete.ts), next to the socket.
export function completionCacheFile(profile: string) {
	return path.join(profile, "cli", "completion.json");
}

// The socket's folder belongs to this user and only they may enter it; a
// folder someone else owns, or a symlink in its place, is refused.
export function privateDir(dir: string) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir} is not a folder`);
	if (process.getuid && stat.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
	if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

// A socket path longer than sockaddr_un holds (104 bytes on macOS, 108 on
// Linux) cannot be bound or connected, which a deep --profile reaches. Such a
// socket is addressed by its name relative to its folder, after changing into
// it: this returns the name to use and leaves the process in that folder,
// which the caller restores (the app) or keeps (the one-shot command).
const MAX_SOCKET_PATH = 100;

export function enterSocketDir(address: CliAddress): string {
	if (!address.dir || Buffer.byteLength(address.path) <= MAX_SOCKET_PATH) return address.path;
	process.chdir(address.dir);
	return SOCKET_NAME;
}

// Reads one newline-terminated JSON value from a stream of chunks, refusing
// more than `limit` bytes. Returns undefined until the line is complete.
export class LineReader {
	#buffer = "";
	constructor(readonly limit: number) {}

	push(chunk: string): unknown {
		this.#buffer += chunk;
		if (this.#buffer.length > this.limit) throw new Error("message too large");
		const end = this.#buffer.indexOf("\n");
		if (end < 0) return undefined;
		return JSON.parse(this.#buffer.slice(0, end));
	}
}

const MAX_RESPONSE = 64 << 20;

// Sends one request and resolves with the app's answer, or rejects with the
// connection error (ENOENT or ECONNREFUSED: no app serves this profile), or
// after `timeout` ms without an answer when one is given. A long socket path
// leaves the process in the socket's folder (enterSocketDir).
export function ask(address: CliAddress, request: CliRequest, timeout?: number): Promise<CliResponse> {
	return new Promise((resolve, reject) => {
		const reader = new LineReader(MAX_RESPONSE);
		const socket = net.connect(enterSocketDir(address));
		const timer = timeout === undefined ? null : setTimeout(() => {
			reject(new Error("The app did not answer in time."));
			socket.destroy();
		}, timeout);
		const settle = () => timer && clearTimeout(timer);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			try {
				const response = reader.push(chunk) as CliResponse | undefined;
				if (response === undefined) return;
				settle();
				resolve(response);
				socket.end();
			} catch (err) {
				settle();
				reject(err);
				socket.destroy();
			}
		});
		socket.on("error", (err) => {
			settle();
			reject(err);
		});
		socket.on("close", () => {
			settle();
			reject(new Error("The app closed the connection without an answer."));
		});
	});
}
