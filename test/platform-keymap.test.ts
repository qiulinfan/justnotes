import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { Commands, compileModifiers, HotkeyManager } from "../src/api/keymap";

installLanguageExtensions();

// Stand-ins for the focused elements a keydown can target.
const doc = { activeElement: null as unknown };
const editorContent = { tagName: "DIV", isContentEditable: true, ownerDocument: doc };
const sidebarInput = { tagName: "INPUT", isContentEditable: false, ownerDocument: doc };
const paletteInput = { tagName: "INPUT", isContentEditable: false, ownerDocument: doc };

function keydownIn(target: object) {
	doc.activeElement = target;
	return { type: "keydown", target, repeat: false } as unknown as KeyboardEvent;
}

function appWithNote() {
	const app: any = { workspace: { activeEditor: { editor: { cm: { contentDOM: editorContent } } } }, lastEvent: null };
	app.hotkeyManager = new HotkeyManager(app);
	app.commands = new Commands(app);
	const edits: string[] = [];
	app.commands.addCommand({ id: "p:bold", name: "Bold", editorCallback: () => edits.push("bold"), hotkeys: [{ modifiers: ["Mod"], key: "b" }] });
	app.commands.addCommand({ id: "p:palette", name: "Palette", callback: () => edits.push("palette"), hotkeys: [{ modifiers: ["Mod"], key: "p" }] });
	return { app, edits };
}

const modKey = (key: string) => ({ modifiers: compileModifiers(["Mod"]), key, vkey: key.toUpperCase() });

describe("hotkeys typed in a text field outside the active editor", () => {
	test("do not run editor commands on the note, which still run from the editor; other commands run", () => {
		const { app, edits } = appWithNote();
		expect(app.hotkeyManager.onTrigger(keydownIn(sidebarInput), modKey("b"))).toBeUndefined();
		expect(app.hotkeyManager.onTrigger(keydownIn(sidebarInput), modKey("p"))).toBe(false);
		expect(app.hotkeyManager.onTrigger(keydownIn(editorContent), modKey("b"))).toBe(false);
		expect(edits).toEqual(["palette", "bold"]);
	});

	test("are held to that when a plugin runs the hotkey without passing the event, as Completr does", () => {
		const { app, edits } = appWithNote();
		const global = globalThis as { event?: unknown };
		global.event = keydownIn(sidebarInput);
		try {
			expect(app.commands.executeCommandById("p:bold")).toBe(false);
		} finally {
			delete global.event;
		}
		expect(edits).toEqual([]);
	});

	test("a command chosen in the palette runs on the note once the palette has given focus back", () => {
		const { app, edits } = appWithNote();
		const enter = keydownIn(paletteInput);
		doc.activeElement = editorContent;
		expect(app.commands.executeCommand(app.commands.findCommand("p:bold"), enter)).toBe(true);
		expect(edits).toEqual(["bold"]);
	});
});
