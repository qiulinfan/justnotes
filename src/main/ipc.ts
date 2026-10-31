import * as fs from "node:fs";
import * as path from "node:path";
import { app, dialog, ipcMain, safeStorage } from "electron";

// IPC handlers the renderer calls into.
export function registerIpc() {
	ipcMain.handle("justnotes:pick-folder", async () => {
		const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
		return picked.canceled ? null : picked.filePaths[0];
	});
	ipcMain.handle("justnotes:request-url", (_evt, req: RequestParams) => requestUrl(req));
	// SecretStorage is synchronous in the renderer, so both calls are sync.
	ipcMain.on("justnotes:secrets-load", (evt, vaultId: string) => {
		evt.returnValue = loadSecrets(vaultId);
	});
	ipcMain.on("justnotes:secret-set", (evt, vaultId: string, id: string, secret: string) => {
		evt.returnValue = setSecret(vaultId, id, secret);
	});
}

interface RequestParams {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}

// requestUrl runs here with Node's fetch, outside Chromium: no CORS, no
// browser-added Origin or Sec-Fetch headers, and headers browsers forbid
// (User-Agent, Cookie, Accept-Encoding) go out as the plugin set them.
async function requestUrl(req: RequestParams) {
	try {
		const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
		const headers: Record<string, string> = {};
		res.headers.forEach((value, name) => {
			headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
		});
		return { status: res.status, headers, body: await res.arrayBuffer() };
	} catch (err) {
		const cause = (err as { cause?: { message?: string } }).cause?.message;
		return { error: cause ?? (err instanceof Error ? err.message : String(err)) };
	}
}

const VAULT_ID = /^[0-9a-f]+$/;
const SECRET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Secrets are kept per vault in the app's user data folder, outside the vault
// (which gets uploaded), each value encrypted with Electron safeStorage.
function secretsFile(vaultId: string) {
	if (!VAULT_ID.test(vaultId)) throw new Error(`Invalid vault id "${vaultId}"`);
	return path.join(app.getPath("userData"), "secrets", `${vaultId}.json`);
}

function readSealed(file: string): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

// Without a secrets file the keychain is never touched.
function loadSecrets(vaultId: string) {
	const secrets: Record<string, string> = {};
	for (const [id, sealed] of Object.entries(readSealed(secretsFile(vaultId)))) {
		try {
			secrets[id] = safeStorage.decryptString(Buffer.from(sealed, "base64"));
		} catch (err) {
			console.error(`Secret "${id}" could not be decrypted`, err);
		}
	}
	return secrets;
}

// Returns null once the secret is on disk, or the error message. An empty
// secret removes the id.
function setSecret(vaultId: string, id: string, secret: string) {
	try {
		if (!SECRET_ID.test(id)) throw new Error(`Invalid secret id "${id}"`);
		const file = secretsFile(vaultId);
		const sealed = readSealed(file);
		if (secret === "") delete sealed[id];
		else {
			if (!safeStorage.isEncryptionAvailable()) throw new Error("Encrypted storage is not available on this device");
			sealed[id] = safeStorage.encryptString(secret).toString("base64");
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(`${file}.tmp`, JSON.stringify(sealed, null, "\t"), { mode: 0o600 });
		fs.renameSync(`${file}.tmp`, file);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
