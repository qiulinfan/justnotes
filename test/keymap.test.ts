import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { type Command, Commands, HotkeyManager, Keymap, Scope } from "../src/api/keymap";

installLanguageExtensions();

// The one matcher behind Scope.handleKey, HotkeyManager.onTrigger and plugins
// that call app.keymap.constructor.isMatch (terminal).
describe("Keymap.isMatch", () => {
	test("a lower-case handler key matches the physical key when Option changes the character", () => {
		// latex-live registers Mod+Alt+"f"; on macOS the event's key is "ƒ".
		expect(Keymap.isMatch({ modifiers: "Alt,Meta", key: "f" }, { modifiers: "Alt,Meta", key: "ƒ", vkey: "F" })).toBe(true);
	});

	test("modifiers must be equal unless the handler takes any", () => {
		const ctx = { modifiers: "Meta,Shift", key: "P", vkey: "P" };
		expect(Keymap.isMatch({ modifiers: "Meta", key: "p" }, ctx)).toBe(false);
		expect(Keymap.isMatch({ modifiers: null, key: "p" }, ctx)).toBe(true);
		expect(Keymap.isMatch({ modifiers: "Meta,Shift", key: null }, ctx)).toBe(true);
	});
});

describe("KeymapContext.vkey", () => {
	test("handlers see punctuation and numpad keys named by the US key, whatever Shift, Option or the layout print", () => {
		const root = new Scope();
		const win = new EventTarget();
		new Keymap(root, win);
		const seen: string[] = [];
		root.register(null, null, (_evt, ctx) => {
			seen.push(ctx.vkey);
		});
		const keys = [
			["Slash", "?"],
			["BracketLeft", "“"],
			["Numpad7", "Home"],
			["KeyF", "ƒ"],
			["ArrowUp", "ArrowUp"],
		];
		for (const [code, key] of keys) win.dispatchEvent(Object.assign(new Event("keydown"), { code, key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }));
		expect(seen).toEqual(["/", "[", "7", "F", "ArrowUp"]);
	});
});

function fakeApp(activeEditor: { editor: unknown } | null = null) {
	const app: any = { workspace: { activeEditor }, lastEvent: null };
	app.hotkeyManager = new HotkeyManager(app);
	app.commands = new Commands(app);
	return app;
}

const keydown = { repeat: false } as KeyboardEvent;

describe("HotkeyManager", () => {
	test("a custom hotkey for a command added after the first bake still runs it", () => {
		// The owner binds Completr's insert command to Tab in hotkeys.json; the
		// command has no default hotkey and is registered when the plugin loads.
		const app = fakeApp();
		app.hotkeyManager.customKeys = { "p:insert": [{ modifiers: [], key: "Tab" }] };
		app.hotkeyManager.bake();
		let ran = 0;
		app.commands.addCommand({ id: "p:insert", name: "Insert", callback: () => ran++ });
		expect(app.hotkeyManager.onTrigger(keydown, { modifiers: "", key: "Tab", vkey: "Tab" })).toBe(false);
		expect(ran).toBe(1);
	});

	test("commands deleted from commands.commands directly are left out of the next bake", () => {
		// QuickAdd removes its commands with `delete commands.commands[id]`.
		const app = fakeApp();
		app.commands.addCommand({ id: "a:one", name: "One", callback() {}, hotkeys: [{ modifiers: ["Mod"], key: "1" }] });
		app.commands.addCommand({ id: "a:two", name: "Two", callback() {}, hotkeys: [{ modifiers: ["Mod"], key: "2" }] });
		delete app.commands.commands["a:one"];
		app.hotkeyManager.baked = false;
		app.hotkeyManager.bake();
		expect(app.hotkeyManager.bakedIds).toEqual(["a:two"]);
	});
});

describe("Commands", () => {
	test("editorCallback overrides checkCallback, and needs an active editor", () => {
		const calls: string[] = [];
		const cmd: Command = {
			id: "x:both",
			name: "Both",
			checkCallback: (checking) => {
				if (!checking) calls.push("check");
				return true;
			},
			editorCallback: () => calls.push("editor"),
		};
		expect(fakeApp(null).commands.executeCommand(cmd)).toBe(false);
		expect(fakeApp({ editor: {} }).commands.executeCommand(cmd)).toBe(true);
		expect(calls).toEqual(["editor"]);
	});

	test("editorCheckCallback decides availability over editorCallback", () => {
		const app = fakeApp({ editor: {} });
		const cmd: Command = { id: "x:check", name: "Check", editorCheckCallback: () => false, editorCallback: () => {} };
		expect(app.commands.isAvailable(cmd)).toBe(false);
		expect(app.commands.executeCommand(cmd)).toBe(false);
	});

	test("mobile-only commands are neither offered nor run on desktop", () => {
		const app = fakeApp();
		let ran = false;
		const cmd: Command = { id: "x:mobile", name: "Mobile", mobileOnly: true, callback: () => (ran = true) };
		expect(app.commands.isAvailable(cmd)).toBe(false);
		expect(app.commands.executeCommand(cmd)).toBe(false);
		expect(ran).toBe(false);
	});
});
