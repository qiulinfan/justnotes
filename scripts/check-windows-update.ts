// Exercise the packaged Windows updater in an isolated copy, with release HTTP responses replaced in main.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { psWord } from "../src/main/update-check";

if (process.platform !== "win32") throw new Error("This package check runs on Windows");
const packaged = path.resolve(process.argv[2] ?? "release/win-unpacked/justnotes.exe");
if (!fs.statSync(packaged).isFile()) throw new Error("No packaged justnotes.exe");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "justnotes updater package "));
const installed = path.join(root, "app");
const payload = path.join(root, "payload");
const profile = path.join(root, "profile");
const vault = path.join(root, "vault");
fs.cpSync(path.dirname(packaged), installed, { recursive: true });
fs.cpSync(path.dirname(packaged), payload, { recursive: true });
fs.writeFileSync(path.join(payload, "updated-marker.txt"), "new release");
fs.mkdirSync(vault);
fs.writeFileSync(path.join(vault, "Welcome.md"), "# Preserved note\n");
const zip = path.join(root, "release.zip");
const archive = Bun.spawnSync(["tar", "-a", "-cf", zip, "-C", payload, "."], {
	stdout: "pipe",
	stderr: "pipe",
	windowsHide: true,
});
if (archive.exitCode !== 0) throw new Error(archive.stderr.toString());
const before = fs.statSync(installed, { bigint: true });
let launchDirectory = installed;
const aliasScript = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Write((New-Object -ComObject Scripting.FileSystemObject).GetFolder(${psWord(installed)}).ShortPath)`;
const alias = Bun.spawnSync(["powershell.exe", "-NoProfile", "-EncodedCommand", Buffer.from(aliasScript, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", windowsHide: true });
const shortDirectory = alias.stdout
	.toString()
	.replace(/^\uFEFF/, "")
	.trim();
if (alias.exitCode === 0 && shortDirectory.includes("~") && fs.existsSync(shortDirectory)) {
	const identity = fs.statSync(shortDirectory, { bigint: true });
	if (identity.ino !== before.ino || identity.dev !== before.dev) throw new Error("Short path does not identify the package directory");
	launchDirectory = shortDirectory;
	console.log("Exercising Windows 8.3 launch-path aliases");
} else console.log("Windows 8.3 alias check skipped: this volume supplied no short alias");
const child = spawn(path.join(launchDirectory, "justnotes.exe"), ["--background", "--use-mock-keychain", "--profile", profile, "--vault", vault, "--remote-debugging-port=0", "--disable-background-timer-throttling"], {
	cwd: root,
	stdio: "ignore",
	windowsHide: true,
});

async function until<T>(read: () => Promise<T | null>, milliseconds = 60_000, label = "condition"): Promise<T> {
	const deadline = Date.now() + milliseconds;
	let lastError: unknown;
	for (;;) {
		try {
			const result = await read();
			if (result !== null) return result;
		} catch (error) {
			lastError = error;
		}
		if (Date.now() >= deadline) throw new Error(`Updater check timed out (${label}): ${lastError ?? "not ready"}; files kept at ${root}`);
		await Bun.sleep(100);
	}
}

async function connect() {
	const url = await until(
		async () => {
			const port = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0];
			const response = await fetch(`http://127.0.0.1:${port}/json`, {
				signal: AbortSignal.timeout(1000),
			});
			const pages = (await response.json()) as {
				type: string;
				url: string;
				webSocketDebuggerUrl: string;
			}[];
			return pages.find((page) => page.type === "page" && page.url.includes("index.html"))?.webSocketDebuggerUrl ?? null;
		},
		60_000,
		"debugger endpoint",
	);
	const socket = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error("CDP connection failed"));
	});
	let sequence = 0;
	const replies = new Map<number, (value: any) => void>();
	socket.onmessage = (event) => {
		const value = JSON.parse(String(event.data));
		if (value.id) replies.get(value.id)?.(value);
	};
	const evaluate = async (expression: string) => {
		const id = ++sequence;
		const reply = new Promise<any>((resolve, reject) => {
			replies.set(id, resolve);
			setTimeout(() => {
				if (replies.delete(id)) reject(new Error("CDP evaluation timed out"));
			}, 10_000).unref();
		});
		socket.send(
			JSON.stringify({
				id,
				method: "Runtime.evaluate",
				params: { expression, awaitPromise: true, returnByValue: true },
			}),
		);
		const result = await reply;
		replies.delete(id);
		if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
		return result.result?.result?.value;
	};
	try {
		await until(async () => ((await evaluate("!!window.app?.workspace?.layoutReady")) ? true : null), 60_000, "vault ready");
	} catch (error) {
		socket.close();
		throw error;
	}
	return { evaluate, close: () => socket.close() };
}

async function closePreview() {
	try {
		const [port, browserPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: AbortSignal.timeout(1000),
		});
		const endpoint = ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
		if (new URL(endpoint).pathname !== browserPath) return;
		const socket = new WebSocket(endpoint);
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(resolve, 2000);
			const done = () => {
				clearTimeout(timeout);
				resolve();
			};
			socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
			socket.onclose = done;
			socket.onerror = done;
		});
		socket.close();
	} catch {}
}

let page: Awaited<ReturnType<typeof connect>> | undefined;
try {
	page = await connect();
	console.log("Packaged vault ready");
	// Finish the startup check before replacing its HTTP source; otherwise checkOnce shares that older request.
	await until(
		async () => {
			const state = await page!.evaluate("require('electron').ipcRenderer.sendSync('justnotes:update-state')");
			return state?.status === "current" || state?.status === "error" ? true : null;
		},
		60_000,
		"initial check complete",
	);
	const tag = "main-999.0.0-aaaaaaaa";
	const asset = "justnotes-999.0.0-win-x64.zip";
	const download = `https://github.com/qiulinfan/justnotes/releases/download/${tag}/${asset}`;
	const release = {
		tag_name: tag,
		published_at: new Date(Date.now() + 60_000).toISOString(),
		assets: [{ name: asset, browser_download_url: download, size: fs.statSync(zip).size }],
	};
	const hook = `(() => {
const electron = process.mainModule.require('electron');
const fs = process.mainModule.require('node:fs');
const original = electron.net.fetch.bind(electron.net);
electron.net.fetch = async input => {
 const url = String(input);
 if (url === 'https://api.github.com/repos/qiulinfan/justnotes/releases/latest') return new Response(JSON.stringify(${JSON.stringify(release)}), {headers:{'content-type':'application/json'}});
 if (url === ${JSON.stringify(download)}) return new Response(fs.readFileSync(${JSON.stringify(zip)}));
 return original(input);
}; return true;
})()`;
	await page.evaluate(`require('@electron/remote').require('vm').runInThisContext(${JSON.stringify(hook)})`);
	console.log("Release source attached");
	await page.evaluate("localStorage.setItem('updater-test-sentinel','preserved'); require('electron').ipcRenderer.send('justnotes:update-auto',false); require('electron').ipcRenderer.send('justnotes:update-auto',true); true");
	await until(
		async () => {
			const state = await page!.evaluate("require('electron').ipcRenderer.sendSync('justnotes:update-state')");
			if (state?.status === "error") throw new Error(state.error);
			return state?.status === "ready" && state.tag === tag ? true : null;
		},
		60_000,
		"release staged",
	);
	console.log("Automatic update staged");
	await page.evaluate("require('electron').ipcRenderer.send('justnotes:update-restart'); true");
	page.close();
	page = undefined;
	await until(async () => (fs.existsSync(path.join(installed, "updated-marker.txt")) ? true : null), 60_000, "replacement complete");
	page = await connect();
	if ((await page.evaluate("localStorage.getItem('updater-test-sentinel')")) !== "preserved") throw new Error("The profile changed during update");
	const after = fs.statSync(installed, { bigint: true });
	if (after.ino !== before.ino || after.dev !== before.dev) throw new Error("The installation directory was replaced");
	if (fs.readFileSync(path.join(vault, "Welcome.md"), "utf8") !== "# Preserved note\n") throw new Error("The vault changed during update");
	if (!fs.existsSync(path.join(installed + ".previous", "justnotes.exe"))) throw new Error("No previous binary was retained");
	console.log("Windows package update passed: automatic discovery, download, in-place replacement, relaunch, profile and vault preservation");
} finally {
	if (page) {
		await page.evaluate("setTimeout(()=>require('@electron/remote').app.quit(),50); true").catch(() => {});
		page.close();
	}
	await closePreview();
	if (child.exitCode === null && child.signalCode === null) {
		await Promise.race([new Promise((resolve) => child.once("exit", resolve)), Bun.sleep(5000)]);
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
	console.log(`Isolated package check: ${root}`);
}
