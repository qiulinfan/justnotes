import type { App } from "./app";
import { Platform } from "./util";

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

export interface Hotkey {
	modifiers: Modifier[];
	key: string;
}

export interface KeymapContext {
	modifiers: string | null;
	key: string | null;
	vkey: string;
}

export interface KeymapEventHandler {
	scope: Scope;
	modifiers: string | null;
	key: string | null;
	func: (evt: KeyboardEvent, ctx: KeymapContext) => false | any;
}

const ORDER = ["Alt", "Ctrl", "Meta", "Shift"];

// "Mod" becomes the platform's command key; the result is a canonical
// comma-joined string, the same shape as KeymapContext.modifiers.
export function compileModifiers(modifiers: string[]) {
	const mapped = modifiers.map((m) => (m === "Mod" ? (Platform.isMacOS ? "Meta" : "Ctrl") : m));
	return ORDER.filter((m) => mapped.includes(m)).join(",");
}

function eventModifiers(evt: KeyboardEvent | MouseEvent) {
	const mods: string[] = [];
	if (evt.altKey) mods.push("Alt");
	if (evt.ctrlKey) mods.push("Ctrl");
	if (evt.metaKey) mods.push("Meta");
	if (evt.shiftKey) mods.push("Shift");
	return mods.join(",");
}

function virtualKey(evt: KeyboardEvent) {
	const code = evt.code;
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit\d$/.test(code)) return code.slice(5);
	if (code === "Space") return " ";
	return evt.key;
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
			if (h.modifiers !== null && h.modifiers !== ctx.modifiers) continue;
			if (h.key !== null && h.key.toLowerCase() !== ctx.key?.toLowerCase() && h.key !== ctx.vkey) continue;
			if (h.func(evt, ctx) === false) return false;
		}
		return this.parent?.handleKey(evt, ctx);
	}
}

export class Keymap {
	#stack: Scope[] = [];
	#root: Scope;

	constructor(root: Scope) {
		this.#root = root;
		window.addEventListener("keydown", (evt) => this.#onKeyDown(evt), true);
	}

	pushScope(scope: Scope) {
		this.#stack.remove(scope);
		this.#stack.push(scope);
	}

	popScope(scope: Scope) {
		this.#stack.remove(scope);
	}

	getRootScope() {
		return this.#root;
	}

	#onKeyDown(evt: KeyboardEvent) {
		if (evt.isComposing) return;
		const ctx: KeymapContext = { modifiers: eventModifiers(evt), key: evt.key, vkey: virtualKey(evt) };
		const scope = this.#stack.last() ?? this.#root;
		if (scope.handleKey(evt, ctx) === false) {
			evt.preventDefault();
			evt.stopPropagation();
		}
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

	bake() {
		if (this.baked) return;
		this.bakedHotkeys = [];
		this.bakedIds = [];
		const ids = new Set([...Object.keys(this.defaultKeys), ...Object.keys(this.customKeys)]);
		for (const id of ids) {
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
			const hk = this.bakedHotkeys[i];
			if (hk.modifiers !== ctx.modifiers) continue;
			if (hk.key.toLowerCase() !== ctx.key?.toLowerCase() && hk.key !== ctx.vkey) continue;
			const cmd = this.app.commands.findCommand(this.bakedIds[i]);
			if (!cmd || (evt.repeat && !cmd.repeatable)) continue;
			if (cmd.isVisible && !cmd.isVisible()) continue;
			if (this.app.commands.executeCommand(cmd)) return false;
		}
	}
}

export class Commands {
	app: App;
	commands: Record<string, Command> = {};
	editorCommands: Record<string, Command> = {};

	constructor(app: App) {
		this.app = app;
	}

	addCommand(command: Command) {
		this.commands[command.id] = command;
		if (command.hotkeys) this.app.hotkeyManager.addDefaultHotkeys(command.id, command.hotkeys);
	}

	removeCommand(id: string) {
		delete this.commands[id];
		this.app.hotkeyManager.removeDefaultHotkeys(id);
	}

	findCommand(id: string) {
		return this.commands[id];
	}

	listCommands() {
		return Object.values(this.commands);
	}

	#editorContext() {
		const view = this.app.workspace.activeEditor;
		return view?.editor ? view : null;
	}

	// Whether the command can run now, without running it.
	isAvailable(cmd: Command) {
		if (cmd.checkCallback) return !!cmd.checkCallback(true);
		if (cmd.editorCheckCallback || cmd.editorCallback) {
			const ctx = this.#editorContext();
			if (!ctx) return false;
			return cmd.editorCheckCallback ? !!cmd.editorCheckCallback(true, ctx.editor, ctx) : true;
		}
		return !!cmd.callback;
	}

	executeCommand(cmd: Command, _evt?: Event) {
		try {
			if (cmd.checkCallback) {
				if (!cmd.checkCallback(true)) return false;
				cmd.checkCallback(false);
				return true;
			}
			if (cmd.editorCheckCallback || cmd.editorCallback) {
				const ctx = this.#editorContext();
				if (!ctx) return false;
				if (cmd.editorCheckCallback) {
					if (!cmd.editorCheckCallback(true, ctx.editor, ctx)) return false;
					cmd.editorCheckCallback(false, ctx.editor, ctx);
				} else cmd.editorCallback!(ctx.editor, ctx);
				return true;
			}
			if (cmd.callback) {
				cmd.callback();
				return true;
			}
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
