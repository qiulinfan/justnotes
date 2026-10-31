import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import * as zlib from "node:zlib";
// A namespace import, so tests can load this module outside Electron.
import * as electron from "electron";
import type { RawResponse } from "../api/util";
import { readKnownVaults, realPathOf } from "../cli/vaults";

export { realPathOf, vaultNamed, vaultOf } from "../cli/vaults";

// IPC handlers the renderer calls into.
export function registerIpc() {
	const { dialog, ipcMain } = electron;
	ipcMain.handle("justnotes:pick-folder", async () => {
		const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
		return picked.canceled ? null : picked.filePaths[0];
	});
	ipcMain.handle("justnotes:request-url", (evt, req: RequestParams) => requestUrl(req, evt.sender.getUserAgent()));
	// SecretStorage is synchronous in the renderer, which waits on sendSync
	// until the reply is set.
	ipcMain.on("justnotes:secrets-load", async (evt, vaultId: string) => {
		evt.returnValue = await loadSecrets(vaultId);
	});
	ipcMain.on("justnotes:secret-set", async (evt, vaultId: string, id: string, secret: string) => {
		evt.returnValue = await setSecret(vaultId, id, secret);
	});
	// So is the clipboard plugins get from require("electron") (dom.ts).
	ipcMain.on("justnotes:clipboard", async (evt, method: string, ...args: unknown[]) => {
		evt.returnValue = await clipboardCall(electron.clipboard, electron.ClipboardItem, method, args);
	});
}

type AsyncClipboard = Pick<electron.Clipboard, "clear" | "has" | "read" | "readText" | "write" | "writeText">;
export type ClipboardReply = { value: unknown } | { error: string };

// Obsidian's renderer has Electron's old synchronous clipboard, and plugins
// call it as such (latex-live reads the text and the HTML of a copied table).
// Electron 45 has only the main process's clipboard, asynchronous, with read()
// and write() of items by MIME type; the old calls are made of those here.
// Images cross as PNG bytes, null when the clipboard holds none. The renderer
// waits for the reply, so this resolves with the value or the error and never
// rejects.
export async function clipboardCall(clipboard: AsyncClipboard, Item: typeof electron.ClipboardItem, method: string, args: unknown[]): Promise<ClipboardReply> {
	const payload = async (type: string) => {
		for (const item of await clipboard.read()) if (item.types.includes(type)) return (await item.getType(type)) as Blob;
		return null;
	};
	const calls: Record<string, (...args: any[]) => unknown> = {
		readText: () => clipboard.readText(),
		writeText: (text: string) => clipboard.writeText(String(text)),
		readHTML: async () => {
			const html = await payload("text/html");
			return html ? html.text() : "";
		},
		writeHTML: (markup: string) => clipboard.write([new Item({ "text/html": String(markup) })]),
		readImage: async () => {
			const png = await payload("image/png");
			return png ? new Uint8Array(await png.arrayBuffer()) : null;
		},
		writeImage: (png: Uint8Array<ArrayBuffer>) => clipboard.write([new Item({ "image/png": new Blob([png], { type: "image/png" }) })]),
		availableFormats: async () => [...new Set((await clipboard.read()).flatMap((item) => item.types))],
		has: (format: string) => clipboard.has(format),
		clear: () => clipboard.clear(),
	};
	try {
		if (!Object.hasOwn(calls, method)) throw new Error(`clipboard.${method} is not available`);
		return { value: await calls[method](...args) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// One requestUrl call, as the renderer sends it.
export interface RequestParams {
	url: string;
	method: string;
	headers: Record<string, string>;
	contentType?: string;
	body?: string | ArrayBuffer | ArrayBufferView;
}

// The headers to send: the plugin's own, as given, except that `contentType`
// replaces a Content-Type in any case. User-Agent (the app's) and Accept are
// added only when the plugin sets none.
export function requestHeaders(req: Pick<RequestParams, "headers" | "contentType">, userAgent: string) {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.headers ?? {})) {
		if (req.contentType && name.toLowerCase() === "content-type") continue;
		headers[name] = String(value);
	}
	if (req.contentType) headers["Content-Type"] = req.contentType;
	if (!hasHeader(headers, "user-agent")) headers["User-Agent"] = userAgent;
	if (!hasHeader(headers, "accept")) headers.Accept = "*/*";
	return headers;
}

function hasHeader(headers: Record<string, string>, name: string) {
	return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function withoutHeaders(headers: Record<string, string>, names: string[]) {
	return Object.fromEntries(Object.entries(headers).filter(([key]) => !names.includes(key.toLowerCase())));
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

// requestUrl runs here with Node's http and https, outside Chromium and
// without fetch: no CORS, no Origin or Sec-Fetch-* headers, and the plugin's
// headers (User-Agent, Cookie, Accept-Encoding) go out exactly as given, a GET
// body included. Redirects are followed and compressed bodies decoded, as
// fetch does. It does not use the system proxy. Resolves with the response or
// with why the request could not be made; it never rejects.
export async function requestUrl(req: RequestParams, userAgent: string): Promise<RawResponse> {
	try {
		let url = new URL(req.url);
		let method = req.method.toUpperCase();
		let headers = requestHeaders(req, userAgent);
		let body = bodyBuffer(req.body);
		for (let redirects = 0; ; redirects++) {
			const res = await send(url, method, headers, body);
			const status = res.statusCode ?? 0;
			const location = res.headers.location;
			if (!REDIRECTS.has(status) || location === undefined) {
				return { status, headers: responseHeaders(res), body: await readBody(res, method) };
			}
			res.resume();
			if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects");
			const next = new URL(location, url);
			if ((status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
				method = "GET";
				body = undefined;
				headers = withoutHeaders(headers, ["content-type", "content-length", "content-encoding", "content-language", "content-location"]);
			}
			// Credentials never follow a redirect to another origin.
			if (next.origin !== url.origin) headers = withoutHeaders(headers, ["authorization", "proxy-authorization", "cookie", "host"]);
			url = next;
		}
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function bodyBuffer(body: RequestParams["body"]) {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	return Buffer.from(body);
}

function send(url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined) {
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Unsupported protocol "${url.protocol}"`);
	// Node sends a GET or DELETE body without a length unless told it.
	if (body && !hasHeader(headers, "content-length") && !hasHeader(headers, "transfer-encoding")) {
		headers = { ...headers, "Content-Length": String(body.byteLength) };
	}
	return new Promise<http.IncomingMessage>((resolve, reject) => {
		const options = { method, headers };
		const request = url.protocol === "https:" ? https.request(url, options, resolve) : http.request(url, options, resolve);
		request.on("error", reject);
		request.end(body);
	});
}

// Header names lower-cased; a repeated header (set-cookie) is joined with ", ".
function responseHeaders(res: http.IncomingMessage) {
	const headers: Record<string, string> = {};
	for (let i = 0; i < res.rawHeaders.length; i += 2) {
		const name = res.rawHeaders[i].toLowerCase();
		const value = res.rawHeaders[i + 1];
		headers[name] = Object.hasOwn(headers, name) ? `${headers[name]}, ${value}` : value;
	}
	return headers;
}

const lenient = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };

function decoder(encoding: string): ((buf: Buffer) => Promise<Buffer>) | null {
	const run = (fn: (buf: Buffer, cb: (err: Error | null, out: Buffer) => void) => void) => (buf: Buffer) =>
		new Promise<Buffer>((resolve, reject) => fn(buf, (err, out) => (err ? reject(err) : resolve(out))));
	if (encoding === "gzip" || encoding === "x-gzip") return run((buf, cb) => zlib.gunzip(buf, lenient, cb));
	// Some servers send raw deflate data under "deflate".
	if (encoding === "deflate") return run((buf, cb) => zlib.inflate(buf, lenient, (err, out) => (err ? zlib.inflateRaw(buf, lenient, cb) : cb(null, out))));
	if (encoding === "br") return run((buf, cb) => zlib.brotliDecompress(buf, cb));
	if (encoding === "zstd") return run((buf, cb) => zlib.zstdDecompress(buf, cb));
	return null;
}

// The body, decoded as Content-Encoding says; an encoding it does not know
// leaves the body as it came, as fetch does.
async function readBody(res: http.IncomingMessage, method: string) {
	const chunks: Buffer[] = [];
	for await (const chunk of res) chunks.push(chunk as Buffer);
	let body: Buffer = Buffer.concat(chunks);
	const encodings = (res.headers["content-encoding"] ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e && e !== "identity");
	const decoders = encodings.map(decoder);
	if (method !== "HEAD" && body.length > 0 && decoders.every((d) => d !== null)) {
		for (const decode of decoders.reverse()) body = await decode!(body);
	}
	return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

const VAULT_ID = /^[0-9a-f]+$/;
const SECRET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Secrets are kept per vault in the app's user data folder, outside the vault
// (which gets uploaded), each value encrypted with Electron safeStorage.
function secretsFile(vaultId: string) {
	if (!VAULT_ID.test(vaultId)) throw new Error(`Invalid vault id "${vaultId}"`);
	return path.join(electron.app.getPath("userData"), "secrets", `${vaultId}.json`);
}

function readSealed(file: string): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

function writePrivateJson(file: string, data: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, "\t"), { mode: 0o600 });
	fs.renameSync(`${file}.tmp`, file);
}

// Without a secrets file the keychain is never touched. A secret whose key was
// rotated is sealed again with the new one.
async function loadSecrets(vaultId: string) {
	const secrets: Record<string, string> = {};
	try {
		const file = secretsFile(vaultId);
		const sealed = readSealed(file);
		let rotated = false;
		for (const [id, value] of Object.entries(sealed)) {
			try {
				const { result, shouldReEncrypt } = await electron.safeStorage.decryptStringAsync(Buffer.from(value, "base64"));
				secrets[id] = result;
				if (shouldReEncrypt) {
					sealed[id] = (await electron.safeStorage.encryptStringAsync(result)).toString("base64");
					rotated = true;
				}
			} catch (err) {
				console.error(`Secret "${id}" could not be decrypted`, err);
			}
		}
		if (rotated) writePrivateJson(file, sealed);
	} catch (err) {
		console.error("Secrets could not be loaded", err);
	}
	return secrets;
}

// Returns null once the secret is on disk, or the error message. An empty
// secret removes the id.
async function setSecret(vaultId: string, id: string, secret: string) {
	try {
		if (!SECRET_ID.test(id)) throw new Error(`Invalid secret id "${id}"`);
		const file = secretsFile(vaultId);
		const sealed = readSealed(file);
		if (secret === "") delete sealed[id];
		else {
			if (!(await electron.safeStorage.isAsyncEncryptionAvailable())) throw new Error("Encrypted storage is not available on this device");
			sealed[id] = (await electron.safeStorage.encryptStringAsync(secret)).toString("base64");
		}
		writePrivateJson(file, sealed);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

// The vaults opened on purpose, with --vault or the folder picker, by real
// path. Only these open for an obsidian:// link (main.ts), because a vault's
// window runs its community plugins. Kept in the app's user data folder.
function vaultsFile() {
	return path.join(electron.app.getPath("userData"), "vaults.json");
}

export function knownVaults(): string[] {
	return readKnownVaults(electron.app.getPath("userData"));
}

export function rememberVault(vault: string) {
	const real = realPathOf(vault);
	const vaults = knownVaults();
	if (vaults.includes(real)) return;
	try {
		writePrivateJson(vaultsFile(), [...vaults, real]);
	} catch (err) {
		console.error("Could not remember the vault", vault, err);
	}
}
