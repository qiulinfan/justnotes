import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IBufferLine, type ILink, Terminal } from "@xterm/xterm";
import { DragManager } from "../../api/drag-manager";
import { setIcon } from "../../api/icons";
import { Keymap, type KeymapContext, Scope } from "../../api/keymap";
import { Menu } from "../../api/ui/menu";
import { Platform } from "../../api/util";
import { TFile } from "../../api/vault";
import { ItemView, type ViewStateResult } from "../../api/view";
import type { WorkspaceLeaf } from "../../api/workspace";
import type { TerminalAppearance } from "./appearance";
import { appCommandAllowed, type KeyAction, terminalKeyAction } from "./keys";
import { findPathCandidates, osc7Path, shellQuote, vaultPathOf } from "./links";
import type { TerminalService } from "./service";

export const VIEW_TYPE = "terminal";

export interface TerminalState {
	cwd: string;
}

export class TerminalView extends ItemView {
	service: TerminalService;
	terminal: Terminal;
	cwd = "";
	title = "";
	#ptyId: number | null = null;
	#exited: { code: number } | null = null;
	#started = false;
	#opened = false;
	#fit = new FitAddon();
	#search = new SearchAddon();
	#webgl: WebglAddon | null = null;
	#wrapEl!: HTMLElement;
	#backdropEl!: HTMLElement;
	#imageEl!: HTMLElement;
	#hostEl!: HTMLElement;
	#findEl: HTMLElement | null = null;
	#exitEl: HTMLElement | null = null;
	#pendingAck = 0;
	#ackTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, service: TerminalService) {
		super(leaf);
		this.service = service;
		this.icon = "square-terminal";
		this.navigation = false;
		this.scope = new Scope();
		this.scope.register(null, null, (evt, ctx) => this.#appKey(evt, ctx));
		this.terminal = new Terminal({ allowProposedApi: true, scrollback: service.settings.scrollback, ...service.appearance.options });
		service.views.add(this);
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return this.title || "Terminal";
	}

	getState(): TerminalState {
		return { cwd: this.cwd };
	}

	async setState(state: Partial<TerminalState>, result: ViewStateResult) {
		if (!this.#started) {
			this.cwd = typeof state?.cwd === "string" && state.cwd ? state.cwd : this.service.vaultRoot();
			this.#started = true;
			void this.#spawn();
		}
		await super.setState(state, result);
	}

	async onOpen() {
		this.contentEl.addClass("terminal-view");
		this.#wrapEl = this.contentEl.createDiv("terminal-wrap");
		this.#backdropEl = this.#wrapEl.createDiv("terminal-backdrop");
		this.#imageEl = this.#backdropEl.createDiv("terminal-backdrop-image");
		this.#hostEl = this.#wrapEl.createDiv("terminal-host");
		const term = this.terminal;
		term.loadAddon(this.#fit);
		term.loadAddon(this.#search);
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		// Links open through the app's external-link policy (main decides).
		term.loadAddon(new WebLinksAddon((_evt, uri) => window.open(uri, "_blank")));
		term.registerLinkProvider({ provideLinks: (y, callback) => callback(this.#pathLinks(y)) });
		term.parser.registerOscHandler(7, (data) => {
			const dir = osc7Path(data);
			if (dir) {
				this.cwd = dir;
				this.app.workspace.requestSaveLayout();
			}
			return true;
		});
		term.onTitleChange((title) => {
			this.title = title;
			this.leaf.updateHeader();
		});
		term.onData((data) => this.#input(data));
		term.onBinary((data) => this.#input(data));
		term.onResize(({ cols, rows }) => {
			if (this.#ptyId !== null) this.service.resize(this.#ptyId, cols, rows);
		});
		term.onSelectionChange(() => {
			if (this.service.settings.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
		});
		term.attachCustomKeyEventHandler((evt) => this.#keyEvent(evt));
		this.registerDomEvent(this.contentEl, "focusin", () => (this.service.lastFocused = this));
		this.registerDomEvent(this.#hostEl, "contextmenu", (evt) => this.#contextMenu(evt));
		this.registerDomEvent(this.#wrapEl, "dragover", (evt) => this.#dragOver(evt));
		this.registerDomEvent(this.#wrapEl, "drop", (evt) => this.#drop(evt));
		this.register(this.containerEl.onWindowMigrated(() => this.#migrated()));
		this.applyAppearance(this.service.appearance);
		this.#openWhenShown();
	}

	async onClose() {
		this.service.views.delete(this);
		if (this.service.lastFocused === this) this.service.lastFocused = null;
		if (this.#ptyId !== null) this.service.kill(this.#ptyId);
		this.#ptyId = null;
		if (this.#ackTimer !== null) window.clearTimeout(this.#ackTimer);
		this.terminal.dispose();
	}

	onResize() {
		if (!this.#opened) this.#openWhenShown();
		else this.fit();
	}

	// xterm measures its cells when it opens, so it opens once the pane has a
	// size (a terminal restored in a background tab opens when shown); output
	// that arrives before is kept in its buffer.
	#openWhenShown() {
		if (this.#opened || !this.#hostEl.isConnected || this.#hostEl.clientWidth === 0 || this.#hostEl.clientHeight === 0) return;
		this.#opened = true;
		this.terminal.open(this.#hostEl);
		this.#loadRenderer();
		// The textarea's select-all (the Edit menu's Cmd+A) selects the screen.
		const textarea = this.terminal.textarea;
		if (textarea) this.registerDomEvent(textarea, "select", () => textarea.selectionEnd > textarea.selectionStart && this.terminal.selectAll());
		this.fit();
		if (this.containerEl.contains(this.containerEl.doc.activeElement) || this.app.workspace.activeLeaf === this.leaf) this.terminal.focus();
	}

	// WebGL when the GPU allows it, else xterm's DOM renderer.
	#loadRenderer() {
		this.#webgl?.dispose();
		this.#webgl = null;
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => {
				webgl.dispose();
				if (this.#webgl === webgl) this.#webgl = null;
			});
			this.terminal.loadAddon(webgl);
			this.#webgl = webgl;
		} catch {
			this.#webgl = null;
		}
	}

	// Moved to or from a popout: xterm follows the element's new window when
	// opened again, and the WebGL context is made in that window.
	#migrated() {
		if (!this.#opened) return this.#openWhenShown();
		this.terminal.open(this.#hostEl);
		this.#loadRenderer();
		this.applyAppearance(this.service.appearance);
	}

	fit() {
		if (!this.#opened || this.#hostEl.clientWidth === 0 || this.#hostEl.clientHeight === 0) return;
		try {
			this.#fit.fit();
		} catch {}
	}

	focus() {
		this.terminal.focus();
	}

	applyAppearance(look: TerminalAppearance) {
		const term = this.terminal;
		const { theme, ...options } = look.options;
		term.options.scrollback = this.service.settings.scrollback;
		Object.assign(term.options, options);
		term.options.theme = theme;
		const { backdrop, padding } = look;
		this.#backdropEl.style.backgroundColor = backdrop.color;
		this.#backdropEl.style.opacity = String(backdrop.opacity);
		const url = backdrop.image ? this.service.imageUrl(backdrop.image.path) : null;
		this.#imageEl.toggle(!!url);
		if (url && backdrop.image) {
			this.#imageEl.style.backgroundImage = `url("${url}")`;
			this.#imageEl.style.opacity = String(Math.min(1, backdrop.image.opacity));
			this.#imageEl.style.backgroundSize = backdrop.image.size;
			this.#imageEl.style.backgroundPosition = backdrop.image.position;
			this.#imageEl.style.backgroundRepeat = backdrop.image.repeat;
		}
		this.#hostEl.style.inset = `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`;
		this.#hostEl.style.fontFeatureSettings = look.fontFeatureSettings;
		this.fit();
	}

	// Output from the shell; what xterm has drawn is acknowledged to main in
	// batches, which holds the shell back while the page falls behind.
	write(data: string) {
		this.terminal.write(data, () => {
			this.#pendingAck += data.length;
			this.#ackTimer ??= window.setTimeout(() => {
				this.#ackTimer = null;
				if (this.#ptyId !== null && this.#pendingAck) this.service.ack(this.#ptyId, this.#pendingAck);
				this.#pendingAck = 0;
			}, 10);
		});
	}

	get ptyId() {
		return this.#ptyId;
	}

	get exited() {
		return this.#exited !== null;
	}

	async #spawn() {
		this.#exited = null;
		this.#exitEl?.detach();
		this.#exitEl = null;
		const reply = await this.service.spawn(this, this.cwd, this.terminal.cols, this.terminal.rows);
		if ("error" in reply) {
			this.terminal.write(`\x1b[31mThe shell could not start: ${reply.error}\x1b[0m\r\n`);
			this.onExit(-1);
			return;
		}
		this.#ptyId = reply.id;
		if (!this.title) {
			this.title = reply.shell.split(/[/\\]/).pop() ?? "";
			this.leaf.updateHeader();
		}
	}

	onExit(code: number) {
		this.#ptyId = null;
		this.#exited = { code };
		this.#exitEl?.detach();
		const bar = this.#wrapEl.createDiv("terminal-exit");
		bar.createSpan({ text: code === 0 ? "The process exited." : `The process exited with code ${code}.` });
		const restart = bar.createEl("button", { text: "Restart", cls: "mod-cta" });
		restart.addEventListener("click", () => this.restart());
		const close = bar.createEl("button", { text: "Close" });
		close.addEventListener("click", () => this.leaf.detach());
		bar.createSpan({ cls: "terminal-exit-hint", text: "Enter restarts." });
		this.#exitEl = bar;
	}

	restart() {
		if (this.#ptyId !== null) this.service.kill(this.#ptyId);
		this.#ptyId = null;
		this.terminal.write("\r\n");
		void this.#spawn();
		this.terminal.focus();
	}

	#input(data: string) {
		if (this.#ptyId !== null) this.service.input(this.#ptyId, data);
	}

	// The view's scope while it has focus: app hotkeys of window-level
	// commands (any Cmd shortcut on macOS) run; every other key, and the keys
	// the terminal answers itself, go on to xterm.
	#appKey(evt: KeyboardEvent, ctx: KeymapContext) {
		if (terminalKeyAction(evt, Platform.isMacOS, this.terminal.hasSelection())) return;
		const target = evt.target as HTMLElement | null;
		const inFind = !!this.#findEl && !!target && this.#findEl.contains(target);
		const hotkeys = this.app.hotkeyManager;
		hotkeys.bake();
		for (let i = 0; i < hotkeys.bakedHotkeys.length; i++) {
			if (!Keymap.isMatch(hotkeys.bakedHotkeys[i], ctx)) continue;
			const id = hotkeys.bakedIds[i];
			if (!appCommandAllowed(id, evt, Platform.isMacOS) || (inFind && !evt.metaKey && !evt.ctrlKey)) continue;
			const cmd = this.app.commands.findCommand(id);
			if (!cmd || (evt.repeat && !cmd.repeatable)) continue;
			if (this.app.commands.executeCommand(cmd, evt)) return false;
		}
	}

	#keyEvent(evt: KeyboardEvent): boolean {
		if (evt.type !== "keydown") return true;
		// The app's keymap ran a command for it.
		if (evt.defaultPrevented) return false;
		if (this.#exited && evt.key === "Enter" && !evt.metaKey && !evt.ctrlKey && !evt.altKey) {
			this.restart();
			return false;
		}
		const action = terminalKeyAction(evt, Platform.isMacOS, this.terminal.hasSelection());
		if (!action) return true;
		evt.preventDefault();
		this.#run(action);
		return false;
	}

	#run(action: KeyAction) {
		const term = this.terminal;
		if (typeof action === "object") return this.#input(action.send);
		if (action === "copy") {
			if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
		} else if (action === "paste") void this.paste();
		else if (action === "clear") term.clear();
		else if (action === "find") this.openFind();
		else term.selectAll();
	}

	async paste() {
		const text = await navigator.clipboard.readText();
		if (text) this.terminal.paste(text);
	}

	clear() {
		this.terminal.clear();
	}

	openFind() {
		if (this.#findEl) {
			this.#findEl.find("input")?.focus();
			(this.#findEl.find("input") as HTMLInputElement | null)?.select();
			return;
		}
		const bar = this.#wrapEl.createDiv("terminal-find");
		const input = bar.createEl("input", { type: "text", attr: { placeholder: "Find", spellcheck: "false" } });
		const count = bar.createSpan("terminal-find-count");
		const options = { decorations: { matchOverviewRuler: "#888888", activeMatchColorOverviewRuler: "#ffaa00", matchBackground: "#88888866", activeMatchBackground: "#ffaa0099" } };
		const next = (back: boolean) => {
			const q = input.value;
			if (!q) return this.#search.clearDecorations();
			if (back) this.#search.findPrevious(q, options);
			else this.#search.findNext(q, options);
		};
		const button = (icon: string, label: string, run: () => void) => {
			const el = bar.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(el, icon);
			el.addEventListener("click", run);
		};
		button("arrow-up", "Previous match", () => next(true));
		button("arrow-down", "Next match", () => next(false));
		button("x", "Close", () => this.closeFind());
		const results = this.#search.onDidChangeResults(({ resultIndex, resultCount }) => {
			count.setText(resultCount ? `${resultIndex + 1} / ${resultCount}` : input.value ? "No results" : "");
		});
		this.register(() => results.dispose());
		input.addEventListener("input", () => next(false));
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				next(evt.shiftKey);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				this.closeFind();
			}
		});
		const selected = this.terminal.getSelection();
		if (selected && !selected.includes("\n")) input.value = selected;
		this.#findEl = bar;
		input.focus();
		input.select();
		if (input.value) next(false);
	}

	closeFind() {
		this.#search.clearDecorations();
		this.#findEl?.detach();
		this.#findEl = null;
		this.terminal.focus();
	}

	// The paths a buffer line names that are files in the vault, as links
	// that open them (Mod-click in a new tab).
	#pathLinks(y: number): ILink[] {
		const line = this.terminal.buffer.active.getLine(y - 1);
		if (!line) return [];
		const { text, columns } = lineText(line, this.terminal.cols);
		const root = this.service.vaultRoot();
		const links: ILink[] = [];
		for (const candidate of findPathCandidates(text)) {
			const rel = vaultPathOf(candidate.path, this.cwd || root, root, this.service.home);
			const file = rel ? this.app.vault.getAbstractFileByPath(rel) : null;
			if (!(file instanceof TFile)) continue;
			links.push({
				text: text.slice(candidate.start, candidate.end),
				range: { start: { x: columns[candidate.start] + 1, y }, end: { x: columns[candidate.end - 1] + 1, y } },
				decorations: { underline: true, pointerCursor: true },
				activate: (evt) => void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file),
			});
		}
		return links;
	}

	#contextMenu(evt: MouseEvent) {
		evt.preventDefault();
		const menu = new Menu();
		const term = this.terminal;
		menu.addItem((item) =>
			item
				.setTitle("Copy")
				.setIcon("copy")
				.setDisabled(!term.hasSelection())
				.onClick(() => void navigator.clipboard.writeText(term.getSelection())),
		);
		menu.addItem((item) => item.setTitle("Paste").setIcon("clipboard-paste").onClick(() => void this.paste()));
		menu.addItem((item) => item.setTitle("Select all").setIcon("text-select").onClick(() => term.selectAll()));
		menu.addSeparator();
		this.#addTerminalItems(menu);
		menu.showAtMouseEvent(evt);
	}

	#addTerminalItems(menu: Menu) {
		menu.addItem((item) => item.setTitle("Clear").setIcon("eraser").onClick(() => this.clear()));
		menu.addItem((item) => item.setTitle("Find").setIcon("search").onClick(() => this.openFind()));
		menu.addItem((item) => item.setTitle("Restart").setIcon("rotate-ccw").onClick(() => this.restart()));
	}

	onPaneMenu(menu: Menu, source: string) {
		super.onPaneMenu(menu, source);
		menu.addSeparator();
		this.#addTerminalItems(menu);
	}

	// Files dragged from the explorer (or any drag of vault files) type their
	// full paths, quoted for the shell, as the terminal plugin does; so do
	// files dropped from the system.
	#dragOver(evt: DragEvent) {
		const files = DragManager.files(this.app.dragManager.draggable);
		const outside = !this.app.dragManager.draggable && evt.dataTransfer?.types.includes("Files");
		if (!files.length && !outside) return;
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = "copy";
		this.app.dragManager.setAction("Insert path");
	}

	#drop(evt: DragEvent) {
		const files = DragManager.files(this.app.dragManager.draggable);
		let paths: string[];
		if (files.length) paths = files.map((f) => this.service.fullPath(f.path));
		else paths = [...(evt.dataTransfer?.files ?? [])].map((f) => this.service.pathOfDroppedFile(f)).filter((p) => !!p);
		if (!paths.length) return;
		evt.preventDefault();
		this.terminal.paste(`${paths.map((p) => shellQuote(p)).join(" ")} `);
		this.terminal.focus();
	}
}

// A buffer line's text and, for each UTF-16 unit of it, the cell column it
// starts in (wide characters take two cells).
export function lineText(line: IBufferLine, cols: number) {
	let text = "";
	const columns: number[] = [];
	for (let x = 0; x < Math.min(cols, line.length); x++) {
		const cell = line.getCell(x);
		if (!cell || cell.getWidth() === 0) continue;
		const chars = cell.getChars() || " ";
		for (let i = 0; i < chars.length; i++) columns.push(x);
		text += chars;
	}
	return { text, columns };
}
