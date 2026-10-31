// Launch an isolated justnotes instance, report boot errors and loaded plugins,
// then quit it:
//   bun scripts/smoke.ts --vault <copy> [--port 9400] [--profile <dir>] [--shot out.png] [--keep] [-- <electron flag> ...]
// Prints JSON: { ok, plugins, failedPlugins, errors, files }. With --keep the
// instance stays running for further `CDP_PORT=<port> bun scripts/cdp.ts` calls;
// stop it with `pkill -f 'remote-debugging-port=<port>'`. Flags after `--` go
// to Electron, e.g. `-- --use-fake-device-for-media-stream
// --use-fake-ui-for-media-stream` for a synthetic microphone.
import * as os from "node:os";
import * as path from "node:path";

function arg(name: string, fallback?: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

const vault = arg("--vault");
if (!vault) {
	console.error("usage: bun scripts/smoke.ts --vault <copy> [--port N] [--profile DIR] [--shot FILE] [--keep] [-- <electron flag> ...]");
	process.exit(1);
}
const port = arg("--port", "9400")!;
const profile = arg("--profile", path.join(os.tmpdir(), `justnotes-smoke-${port}`))!;
const shot = arg("--shot");
const keep = process.argv.includes("--keep");
const root = path.resolve(import.meta.dir, "..");
const dashes = process.argv.indexOf("--");
const extra = dashes >= 0 ? process.argv.slice(dashes + 1) : [];

// Test windows are usually hidden behind others, where Chromium throttles
// timers and animation frames; pdf.js pages then take a minute to render.
const unthrottled = ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"];
// SecretStorage encrypts with safeStorage, which on macOS uses the login
// keychain; a test instance must neither touch it nor prompt for access.
const mockKeychain = "--use-mock-keychain";
const child = Bun.spawn(
	[path.join(root, "node_modules/.bin/electron"), root, ...unthrottled, mockKeychain, ...extra, "--vault", path.resolve(vault), "--profile", profile, `--remote-debugging-port=${port}`],
	{ stdout: "ignore", stderr: "ignore" },
);

async function pageSocket() {
	for (let i = 0; i < 60; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			// The vault page, not a popout window restored with the layout.
			const page = targets.find((t: any) => t.type === "page" && t.url !== "about:blank");
			if (page) return page.webSocketDebuggerUrl as string;
		} catch {}
		await Bun.sleep(500);
	}
	throw new Error("the window never appeared");
}

const errors: string[] = [];
const ws = new WebSocket(await pageSocket());
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	if (msg.id) pending.get(msg.id)?.(msg);
	else if (msg.method === "Runtime.exceptionThrown") {
		const d = msg.params.exceptionDetails;
		errors.push(d.exception?.description ?? d.text);
	} else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
		errors.push(msg.params.args.map((a: any) => a.description ?? a.value).join(" "));
	}
};
await new Promise((r) => (ws.onopen = r));
const send = (method: string, params: any = {}) =>
	new Promise<any>((resolve) => {
		const i = ++id;
		pending.set(i, resolve);
		ws.send(JSON.stringify({ id: i, method, params }));
	});
const evaluate = async (expression: string) =>
	(await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

// Reload with the console attached, so errors thrown during boot are seen.
await send("Runtime.enable");
await send("Page.reload");
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
	await Bun.sleep(500);
	ready = (await evaluate("!!(window.app && app.workspace && app.workspace.layoutReady)")) === true;
}
await Bun.sleep(1000);
const state = ready
	? await evaluate(
			"(async () => { let wanted = []; try { wanted = JSON.parse(await app.vault.adapter.read(app.vault.configDir + '/community-plugins.json')); } catch {} return JSON.stringify({ plugins: Object.keys(app.plugins.plugins), wanted, files: app.vault.getFiles().length }); })()",
		)
	: null;
const info = state ? JSON.parse(state) : { plugins: [], wanted: [], files: 0 };
if (shot) {
	const r = await send("Page.captureScreenshot", { format: "png" });
	await Bun.write(shot, Buffer.from(r.result.data, "base64"));
}
console.log(
	JSON.stringify(
		{
			ok: ready && errors.length === 0,
			ready,
			plugins: info.plugins,
			failedPlugins: info.wanted.filter((p: string) => !info.plugins.includes(p)),
			files: info.files,
			errors,
		},
		null,
		1,
	),
);
ws.close();
if (!keep) child.kill();
process.exit(0);
