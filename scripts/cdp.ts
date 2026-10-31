// Drive a running justnotes window over the Chrome DevTools Protocol.
// Start the app with `--remote-debugging-port=9333`, then:
//   bun scripts/cdp.ts eval '<js expression>'   evaluate in the page (window.app is the App)
//   bun scripts/cdp.ts type 'text'              type characters as real key events
//   bun scripts/cdp.ts key Enter|Tab|c,12       press a key; the number is a modifier mask (Alt=1 Ctrl=2 Meta=4 Shift=8)
//   bun scripts/cdp.ts selectall                select all in the focused field or editor (Cmd+A / Ctrl+A)
//   bun scripts/cdp.ts shot out.png             screenshot
//   bun scripts/cdp.ts reload                   reload and print uncaught errors for a few seconds
const [mode, arg] = process.argv.slice(2);
const port = process.env.CDP_PORT ?? "9333";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t: any) => t.type === "page").webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	if (msg.id) pending.get(msg.id)?.(msg);
	else if (msg.method === "Runtime.exceptionThrown") console.log(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
	else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
		console.log("console.error:", msg.params.args.map((a: any) => a.description ?? a.value).join(" "));
	}
};
await new Promise((r) => (ws.onopen = r));
const send = (method: string, params: any = {}) =>
	new Promise<any>((resolve) => {
		const i = ++id;
		pending.set(i, resolve);
		ws.send(JSON.stringify({ id: i, method, params }));
	});

const VK: Record<string, number> = {
	Enter: 13,
	Tab: 9,
	Escape: 27,
	ArrowDown: 40,
	ArrowUp: 38,
	ArrowLeft: 37,
	ArrowRight: 39,
	Backspace: 8,
	Delete: 46,
	Home: 36,
	End: 35,
	PageUp: 33,
	PageDown: 34,
};

if (mode === "eval") {
	const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
	console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
} else if (mode === "type") {
	for (const ch of arg) {
		await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
		await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
		await Bun.sleep(40);
	}
} else if (mode === "key") {
	const [key, mods] = arg.split(",");
	const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
	const common = { key, code, modifiers: Number(mods ?? 0), windowsVirtualKeyCode: VK[key] ?? key.toUpperCase().charCodeAt(0) };
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
} else if (mode === "selectall") {
	// An injected Cmd+A never reaches the macOS menu that selects all, so the
	// key carries the editing command itself.
	const common = { key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2, windowsVirtualKeyCode: 65 };
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common, commands: ["selectAll"] });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
} else if (mode === "shot") {
	const r = await send("Page.captureScreenshot", { format: "png" });
	await Bun.write(arg, Buffer.from(r.result.data, "base64"));
	console.log("saved", arg);
} else if (mode === "reload") {
	await send("Runtime.enable");
	await send("Page.reload");
	await Bun.sleep(6000);
}
ws.close();
process.exit(0);
