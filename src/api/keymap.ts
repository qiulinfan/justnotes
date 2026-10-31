import type { App } from "./app";
import { Platform } from "./util";

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

export interface Hotkey {
	modifiers: Modifier[];
	key: string;
}

export interface KeymapInfo {
	modifiers: string | null;
	key: string | null;
}

export interface KeymapContext extends KeymapInfo {
	vkey: string;
}

export interface KeymapEventHandler extends KeymapInfo {
	scope: Scope;
	func: (evt: KeyboardEvent, ctx: KeymapContext) => false | any;
}

const ORDER = ["Alt", "Ctrl", "Meta", "Shift"];

function platformModifier(modifier: string) {
	return modifier === "Mod" ? (Platform.isMacOS ? "Meta" : "Ctrl") : modifier;
}

// "Mod" becomes the platform's command key; the result is a canonical
// comma-joined string, the same shape as KeymapContext.modifiers.
export function compileModifiers(modifiers: string[]) {
	const mapped = modifiers.map(platformModifier);
	return ORDER.filter((m) => mapped.includes(m)).join(",");
}

type ModifierState = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

function eventModifiers(evt: ModifierState) {
	const mods: string[] = [];
	if (evt.altKey) mods.push("Alt");
	if (evt.ctrlKey) mods.push("Ctrl");
	if (evt.metaKey) mods.push("Meta");
	if (evt.shiftKey) mods.push("Shift");
	return mods.join(",");
}

// Keys whose character depends on Shift, Option and the keyboard layout, named
// by the key they print on a US layout, so a hotkey matches the physical key.
const CODE_KEYS: Record<string, string> = {
	Space: " ",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Backquote: "`",
	NumpadAdd: "+",
	NumpadSubtract: "-",
	NumpadMultiply: "*",
	NumpadDivide: "/",
	NumpadDecimal: ".",
	NumpadComma: ",",
	NumpadEqual: "=",
	NumpadEnter: "Enter",
};

export function virtualKey(evt: Pick<KeyboardEvent, "code" | "key">) {
	const code = evt.code;
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^(Digit|Numpad)\d$/.test(code)) return code.slice(-1);
	return CODE_KEYS[code] ?? evt.key;
}

export class Scope {
	parent: Scope | undefined;
	keys: KeymapEventHandler[] = [];

	constructor(parent?: Scope) {
		this.parent = parent;
	}

	register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventHandler["func"]) {
		const handler: KeymapEventHandler = {
			scope: this,
			modifiers: modifiers ? compileModifiers(modifiers) : null,
			key,
			func,
		};
		this.keys.push(handler);
		return handler;
	}

	unregister(handler: KeymapEventHandler) {
		this.keys.remove(handler);
	}

	handleKey(evt: KeyboardEvent, ctx: KeymapContext): false | any {
		for (const h of [...this.keys]) {
			if (!Keymap.isMatch(h, ctx)) continue;
			if (h.func(evt, ctx) === false) return false;
		}
		return this.parent?.handleKey(evt, ctx);
	}
}

export class Keymap {
	rootScope: Scope;
	// Scopes pushed before the active one, most recent last.
	prevScopes: Scope[] = [];
	// The modifier keys held down right now, in KeymapContext.modifiers form.
	modifiers = "";
	#scope: Scope;

	constructor(root: Scope) {
		this.rootScope = this.#scope = root;
		window.addEventListener("keydown", (evt) => this.#onKeyDown(evt), true);
		window.addEventListener("keyup", (evt) => this.updateModifiers(evt), true);
		window.addEventListener("blur", () => (this.modifiers = ""));
	}

	pushScope(scope: Scope) {
		if (scope === this.#scope) return;
		this.prevScopes.remove(scope);
		this.prevScopes.push(this.#scope);
		this.#scope = scope;
	}

	popScope(scope: Scope) {
		if (scope === this.#scope) this.#scope = this.prevScopes.pop() ?? this.rootScope;
		else this.prevScopes.remove(scope);
	}

	getRootScope() {
		return this.rootScope;
	}

	hasModifier(modifier: Modifier) {
		return this.modifiers.split(",").includes(platformModifier(modifier));
	}

	updateModifiers(evt: KeyboardEvent) {
		this.modifiers = Keymap.getModifiers(evt);
	}

	// A handled key is only default-prevented, as the d.ts promises; CodeMirror
	// skips its own key handlers for such events, and element listeners (an
	// input inside a modal) still see the key.
	#onKeyDown(evt: KeyboardEvent) {
		this.updateModifiers(evt);
		if (evt.isComposing) return;
		const ctx: KeymapContext = { modifiers: Keymap.getModifiers(evt), key: evt.key, vkey: virtualKey(evt) };
		if (this.#scope.handleKey(evt, ctx) === false) evt.preventDefault();
	}

	static getModifiers(evt: ModifierState) {
		return eventModifiers(evt);
	}

	// The one hotkey matcher: modifiers must be equal unless the handler takes
	// any, and the key matches the typed key or the physical key, ignoring case.
	static isMatch(info: KeymapInfo, ctx: KeymapContext) {
		if (info.modifiers !== null && info.modifiers !== ctx.modifiers) return false;
		if (info.key === null) return true;
		const key = info.key.toLowerCase();
		return key === ctx.key?.toLowerCase() || key === ctx.vkey?.toLowerCase();
	}

	static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier) {
		const e = evt as KeyboardEvent;
		switch (modifier) {
			case "Mod":
				return Platform.isMacOS ? e.metaKey : e.ctrlKey;
			case "Ctrl":
				return e.ctrlKey;
			case "Meta":
				return e.metaKey;
			case "Shift":
				return e.shiftKey;
			case "Alt":
				return e.altKey;
		}
	}

	static isModEvent(evt?: UserEvent | null): boolean | "tab" | "split" | "window" {
		if (!evt) return false;
		const e = evt as MouseEvent;
		if (e.button === 1) return "tab";
		const mod = Keymap.isModifier(e, "Mod");
		if (mod && e.altKey && e.shiftKey) return "window";
		if (mod && e.altKey) return "split";
		return mod ? "tab" : false;
	}

	static compileModifiers = compileModifiers;
}

type UserEvent = MouseEvent | KeyboardEvent | TouchEvent | PointerEvent;

export interface Command {
	id: string;
	name: string;
	icon?: string;
	mobileOnly?: boolean;
	repeatable?: boolean;
	hotkeys?: Hotkey[];
	callback?: () => any;
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (editor: any, ctx: any) => any;
	editorCheckCallback?: (checking: boolean, editor: any, ctx: any) => boolean | void;
	isVisible?: () => boolean;
	isBypassCommand?: () => boolean;
}

export class HotkeyManager {
	app: App;
	defaultKeys: Record<string, Hotkey[]> = {};
	customKeys: Record<string, Hotkey[]> = {};
	bakedHotkeys: { modifiers: string; key: string }[] = [];
	bakedIds: string[] = [];
	baked = false;

	constructor(app: App) {
		this.app = app;
	}

	async load() {
		try {
			this.customKeys = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/hotkeys.json`));
		} catch {
			this.customKeys = {};
		}
		this.baked = false;
	}

	addDefaultHotkeys(id: string, hotkeys: Hotkey[]) {
		this.defaultKeys[id] = hotkeys;
		this.baked = false;
	}

	removeDefaultHotkeys(id: string) {
		delete this.defaultKeys[id];
		this.baked = false;
	}

	getDefaultHotkeys(id: string) {
		return this.defaultKeys[id];
	}

	getHotkeys(id: string) {
		return this.customKeys[id];
	}

	setHotkeys(id: string, hotkeys: Hotkey[]) {
		this.customKeys[id] = hotkeys;
		this.baked = false;
	}

	removeHotkeys(id: string) {
		delete this.customKeys[id];
		this.baked = false;
	}

	// Plugins may delete from commands.commands directly (QuickAdd does), so
	// only ids that still resolve are baked; adding or removing a command
	// clears `baked`.
	bake() {
		if (this.baked) return;
		this.bakedHotkeys = [];
		this.bakedIds = [];
		const ids = new Set([...Object.keys(this.defaultKeys), ...Object.keys(this.customKeys)]);
		for (const id of ids) {
			if (!this.app.commands.findCommand(id)) continue;
			for (const hk of this.customKeys[id] ?? this.defaultKeys[id] ?? []) {
				this.bakedHotkeys.push({ modifiers: compileModifiers(hk.modifiers ?? []), key: hk.key });
				this.bakedIds.push(id);
			}
		}
		this.baked = true;
	}

	printHotkeyForCommand(id: string) {
		const hk = (this.customKeys[id] ?? this.defaultKeys[id] ?? [])[0];
		if (!hk) return "";
		const glyph: Record<string, string> = Platform.isMacOS
			? { Mod: "⌘", Meta: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥" }
			: { Mod: "Ctrl", Meta: "Win", Ctrl: "Ctrl", Shift: "Shift", Alt: "Alt" };
		const key = hk.key === " " ? "Space" : hk.key.length === 1 ? hk.key.toUpperCase() : hk.key;
		return [...hk.modifiers.map((m) => glyph[m] ?? m), key].join(Platform.isMacOS ? " " : "+");
	}

	// The root scope's catch-all handler: run the first visible command whose
	// hotkey matches. Plugins (e.g. Completr) may replace this handler.
	onTrigger(evt: KeyboardEvent, ctx: KeymapContext) {
		this.bake();
		for (let i = 0; i < this.bakedHotkeys.length; i++) {
			if (!Keymap.isMatch(this.bakedHotkeys[i], ctx)) continue;
			const cmd = this.app.commands.findCommand(this.bakedIds[i]);
			if (!cmd || (evt.repeat && !cmd.repeatable)) continue;
			if (cmd.isVisible && !cmd.isVisible()) continue;
			if (this.app.commands.executeCommand(cmd, evt)) return false;
		}
	}
}

interface EditorContext {
	editor: any;
}

// Runs (or, when checking, only tests) a command with Obsidian's precedence:
// editorCheckCallback over editorCallback over checkCallback over callback.
// Editor callbacks need an active editor; mobile-only commands never run on
// desktop. Returns whether the command can run (or ran).
function runCommand(cmd: Command, checking: boolean, activeEditor: EditorContext | null) {
	if (cmd.mobileOnly && !Platform.isMobile) return false;
	if (cmd.editorCheckCallback || cmd.editorCallback) {
		if (!activeEditor?.editor) return false;
		if (cmd.editorCheckCallback) return !!cmd.editorCheckCallback(checking, activeEditor.editor, activeEditor);
		if (!checking) cmd.editorCallback!(activeEditor.editor, activeEditor);
		return true;
	}
	if (cmd.checkCallback) return !!cmd.checkCallback(checking);
	if (!cmd.callback) return false;
	if (!checking) cmd.callback();
	return true;
}

export class Commands {
	app: App;
	commands: Record<string, Command> = {};
	// Core editor:* commands, also listed in `commands`.
	editorCommands: Record<string, Command> = {};

	constructor(app: App) {
		this.app = app;
	}

	addCommand(command: Command) {
		this.commands[command.id] = command;
		if (command.hotkeys) this.app.hotkeyManager.addDefaultHotkeys(command.id, command.hotkeys);
		this.app.hotkeyManager.baked = false;
	}

	removeCommand(id: string) {
		delete this.commands[id];
		delete this.editorCommands[id];
		this.app.hotkeyManager.removeDefaultHotkeys(id);
	}

	findCommand(id: string): Command | undefined {
		return this.commands[id];
	}

	listCommands() {
		return Object.values(this.commands);
	}

	// Whether the command can run now, without running it.
	isAvailable(cmd: Command) {
		try {
			return runCommand(cmd, true, this.app.workspace.activeEditor);
		} catch (err) {
			console.error(`Command ${cmd.id} failed`, err);
			return false;
		}
	}

	executeCommand(cmd: Command, evt?: Event) {
		if (evt) this.app.lastEvent = evt as UIEvent;
		try {
			const editor = this.app.workspace.activeEditor;
			if (!runCommand(cmd, true, editor)) return false;
			runCommand(cmd, false, editor);
			return true;
		} catch (err) {
			console.error(`Command ${cmd.id} failed`, err);
		}
		return false;
	}

	executeCommandById(id: string, evt?: Event) {
		const cmd = this.findCommand(id);
		return cmd ? this.executeCommand(cmd, evt) : false;
	}
}
