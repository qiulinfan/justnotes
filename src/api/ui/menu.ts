import type { App } from "../app";
import { appWindows } from "../dom";
import { Component } from "../events";
import { setIcon } from "../icons";
import { Scope } from "../keymap";

export interface MenuPositionDef {
	x: number;
	y: number;
	width?: number;
	overlap?: boolean;
	left?: boolean;
}

const SUBMENU_DELAY = 200;

// Menus take no App, so they reach the keymap through the global one.
function globalApp() {
	return (window as Window & { app?: App }).app;
}

export class MenuItem {
	dom: HTMLElement;
	iconEl: HTMLElement;
	titleEl: HTMLElement;
	section = "";
	callback: ((evt: MouseEvent | KeyboardEvent) => any) | null = null;
	disabled = false;
	checked: boolean | null = null;
	submenu: Menu | null = null;
	#menu: Menu;
	#checkEl: HTMLElement | null = null;

	constructor(menu: Menu) {
		this.#menu = menu;
		this.dom = createDiv("menu-item tappable");
		this.iconEl = this.dom.createDiv("menu-item-icon");
		this.titleEl = this.dom.createDiv("menu-item-title");
	}

	setTitle(title: string | DocumentFragment) {
		this.titleEl.setText(title);
		return this;
	}

	setIcon(icon: string | null) {
		if (icon) setIcon(this.iconEl, icon);
		else this.iconEl.empty();
		return this;
	}

	// true or false makes the item checkable (a check shows when true); null
	// makes it an ordinary item again.
	setChecked(checked: boolean | null) {
		this.checked = checked;
		this.dom.toggleClass("mod-checked", checked === true);
		if (checked === true && !this.#checkEl) {
			this.#checkEl = this.titleEl.insertAdjacentElement("afterend", createDiv("menu-item-icon mod-checked")) as HTMLElement;
			setIcon(this.#checkEl, "check");
		} else if (checked !== true) {
			this.#checkEl?.detach();
			this.#checkEl = null;
		}
		return this;
	}

	setDisabled(disabled: boolean) {
		this.disabled = disabled;
		this.dom.toggleClass("is-disabled", disabled);
		return this;
	}

	setWarning(warning: boolean) {
		this.dom.toggleClass("is-warning", warning);
		return this;
	}

	// A label cannot be activated.
	setIsLabel(isLabel: boolean) {
		this.dom.toggleClass("is-label", isLabel);
		this.dom.toggleClass("tappable", !isLabel);
		return this;
	}

	setSection(section: string) {
		this.section = section;
		if (section) this.dom.dataset.section = section;
		else delete this.dom.dataset.section;
		return this;
	}

	setSubmenu() {
		if (!this.submenu) {
			this.submenu = new Menu();
			this.submenu.parentMenu = this.#menu;
			this.dom.addClass("has-submenu");
			setIcon(this.dom.createDiv("menu-item-icon mod-submenu"), "chevron-right");
		}
		return this.submenu;
	}

	onClick(cb: (evt: MouseEvent | KeyboardEvent) => any) {
		this.callback = cb;
		return this;
	}

	// Choosing an item closes the whole menu chain, then runs its callback.
	handleEvent(evt: MouseEvent | KeyboardEvent) {
		if (this.disabled || this.dom.hasClass("is-label")) return;
		if (this.submenu) {
			this.#menu.openSubmenu(this, !!evt?.instanceOf?.(KeyboardEvent));
			return;
		}
		let root = this.#menu;
		while (root.parentMenu) root = root.parentMenu;
		root.hide();
		this.callback?.(evt);
	}
}

export class MenuSeparator {
	dom: HTMLElement;

	constructor(_menu: Menu) {
		this.dom = createDiv("menu-separator");
	}
}

// How Obsidian lays out a menu, as observed in a running Obsidian: sections
// named by addSections come first in that order, then other named sections
// in first-seen order, then items without a section and separators, keeping
// insertion order within each rank. A new group starts at a separator or when
// an item names a different section; items without one join the open group.
// `null` stands for a separator.
// It is the default export because the obsidian module (index.ts) takes this
// file with `export *`, which leaves a default out: plugins never see it.
export default function groupMenuItems<T extends { section: string }>(entries: (T | null)[], declared: string[]): T[][] {
	const named: string[] = [];
	for (const e of entries) if (e?.section && !declared.includes(e.section) && !named.includes(e.section)) named.push(e.section);
	const rank = (e: T | null) => {
		if (!e?.section) return Number.POSITIVE_INFINITY;
		const i = declared.indexOf(e.section);
		return i >= 0 ? i : declared.length + named.indexOf(e.section);
	};
	const sorted = entries.map((e, i) => ({ e, i, r: rank(e) })).sort((a, b) => a.r - b.r || a.i - b.i);
	const groups: T[][] = [];
	let current: T[] | null = null;
	let section = "";
	for (const { e } of sorted) {
		if (!e) {
			current = null;
			continue;
		}
		if (!current || (e.section && e.section !== section)) {
			current = [];
			groups.push(current);
			section = e.section;
		}
		current.push(e);
	}
	return groups;
}

let openMenu: Menu | null = null;
const eventMenus = new WeakMap<Event, Menu>();

export class Menu extends Component {
	dom: HTMLElement;
	scrollEl: HTMLElement;
	items: (MenuItem | MenuSeparator)[] = [];
	sections: string[] = [];
	scope: Scope;
	selected = -1;
	parentMenu: Menu | null = null;
	currentSubmenu: Menu | null = null;
	#visible: MenuItem[] = [];
	#parentEl: HTMLElement | null = null;
	#onHide: (() => any)[] = [];
	#shown = false;
	#used = false;
	#submenuTimer: number | null = null;
	// The windows watched for a click outside the menu.
	#watched: Window[] = [];
	#outside = (evt: MouseEvent) => {
		const target = evt.target as Node;
		if (!this.#contains(target) && !this.#parentEl?.contains(target)) this.hide();
	};
	#gone = () => this.hide();

	constructor() {
		super();
		this.dom = createDiv("menu");
		this.dom.createDiv("menu-grabber");
		this.scrollEl = this.dom.createDiv("menu-scroll");
		// While shown, the menu's scope sits on top of the keymap stack, above
		// any modal underneath.
		this.scope = new Scope();
		this.scope.register([], "ArrowDown", () => {
			this.#move(1);
			return false;
		});
		this.scope.register([], "ArrowUp", () => {
			this.#move(-1);
			return false;
		});
		this.scope.register([], "ArrowRight", () => {
			const item = this.#visible[this.selected];
			if (item?.submenu) this.openSubmenu(item, true);
			return false;
		});
		this.scope.register([], "ArrowLeft", () => {
			if (this.parentMenu) this.hide();
			return false;
		});
		// Enter belongs to the menu even with nothing selected; other keys,
		// such as letters and Backspace, still reach the editor, as in Obsidian.
		this.scope.register([], "Enter", (evt) => {
			this.#visible[this.selected]?.handleEvent(evt);
			return false;
		});
		this.scope.register([], "Escape", () => {
			this.hide();
			return false;
		});
		this.dom.addEventListener("click", (evt) => this.#itemAt(evt)?.handleEvent(evt));
		this.dom.addEventListener("mouseover", (evt) => {
			const item = this.#itemAt(evt);
			if (!item) return;
			const index = this.#visible.indexOf(item);
			if (index === this.selected) return;
			this.select(index);
			this.#scheduleSubmenu(item);
		});
	}

	#itemAt(evt: Event) {
		const el = (evt.target as Element).closest(".menu-item");
		return this.#visible.find((item) => item.dom === el);
	}

	#contains(node: Node): boolean {
		const submenu = this.currentSubmenu;
		return this.dom.contains(node) || (submenu !== null && submenu.#contains(node));
	}

	setNoIcon() {
		this.dom.addClass("mod-no-icon");
		return this;
	}

	// Native menus are not used; this always draws the DOM menu.
	setUseNativeMenu(_useNative: boolean) {
		return this;
	}

	// The fixed section order of a built-in menu.
	addSections(sections: string[]) {
		for (const section of sections) if (!this.sections.includes(section)) this.sections.push(section);
		return this;
	}

	addItem(cb: (item: MenuItem) => any) {
		const item = new MenuItem(this);
		cb(item);
		this.items.push(item);
		return this;
	}

	addSeparator() {
		this.items.push(new MenuSeparator(this));
		return this;
	}

	setParentElement(el: HTMLElement) {
		this.#parentEl = el;
		return this;
	}

	select(index: number) {
		this.#visible[this.selected]?.dom.removeClass("selected");
		this.selected = index;
		const el = this.#visible[index]?.dom;
		el?.addClass("selected");
		el?.scrollIntoView({ block: "nearest" });
	}

	#move(delta: 1 | -1) {
		const items = this.#visible;
		let i = this.selected;
		for (let n = 0; n < items.length; n++) {
			i = i < 0 ? (delta > 0 ? 0 : items.length - 1) : (i + delta + items.length) % items.length;
			// Disabled items are skipped; labels are not, as in Obsidian.
			if (!items[i].disabled) return this.select(i);
		}
	}

	#scheduleSubmenu(item: MenuItem) {
		if (this.#submenuTimer !== null) window.clearTimeout(this.#submenuTimer);
		this.#submenuTimer = window.setTimeout(() => {
			this.#submenuTimer = null;
			if (item.submenu && !item.disabled) this.openSubmenu(item);
			else this.closeSubmenu();
		}, SUBMENU_DELAY);
	}

	openSubmenu(item: MenuItem, selectFirst = false) {
		const submenu = item.submenu;
		if (!submenu) return;
		if (this.currentSubmenu !== submenu) {
			this.closeSubmenu();
			this.currentSubmenu = submenu;
			const r = item.dom.getBoundingClientRect();
			submenu.showAtPosition({ x: r.left, y: r.top - 6, width: r.width }, item.dom.doc);
		}
		if (selectFirst) submenu.#move(1);
	}

	closeSubmenu() {
		this.currentSubmenu?.hide();
		this.currentSubmenu = null;
	}

	#render() {
		this.scrollEl.empty();
		const groups = groupMenuItems(
			this.items.map((i) => (i instanceof MenuItem ? i : null)),
			this.sections,
		);
		this.#visible = groups.flat();
		groups.forEach((group, i) => {
			if (i > 0) this.scrollEl.createDiv("menu-separator");
			const groupEl = this.scrollEl.createDiv("menu-group");
			for (const item of group) groupEl.appendChild(item.dom);
		});
	}

	// `doc` is the window to show in (a popout's); the focused one by default.
	showAtPosition(pos: MenuPositionDef, doc: Document = activeDocument) {
		if (!this.parentMenu) {
			if (openMenu && openMenu !== this) openMenu.hide();
			openMenu = this;
		}
		this.#used = true;
		this.#visible[this.selected]?.dom.removeClass("selected");
		this.selected = -1;
		this.#render();
		doc.body.appendChild(this.dom);
		this.#place(pos);
		this.#parentEl?.addClass("has-active-menu");
		globalApp()?.keymap.pushScope(this.scope);
		this.scope.parent ??= globalApp()?.scope;
		this.#unwatch();
		// Attach after the event that opened the menu has finished. A click in
		// any app window closes it, and so does its window closing: its scope
		// would otherwise keep taking Enter and the arrows from the editor in
		// the window the user went on to.
		if (!this.parentMenu) {
			window.setTimeout(() => {
				if (!this.#shown || this.#watched.length) return;
				this.#watched = appWindows();
				for (const win of this.#watched) win.document.addEventListener("mousedown", this.#outside, true);
				doc.defaultView?.addEventListener("pagehide", this.#gone);
			});
		}
		this.#shown = true;
		this.load();
		return this;
	}

	// Opens beside the anchor (x, width), or over it with `overlap`, towards
	// the right unless `left` asks otherwise or there is no room.
	#place(pos: MenuPositionDef) {
		const window = this.dom.win;
		const w = this.dom.offsetWidth;
		const h = this.dom.offsetHeight;
		const width = pos.width ?? 0;
		const rightward = pos.overlap ? pos.x : pos.x + (width || 2);
		const leftward = pos.overlap ? pos.x + width - w : pos.x - w - 2;
		const fitsRight = rightward + w <= window.innerWidth - 4;
		const fitsLeft = leftward >= 4;
		const left = pos.left ? (fitsLeft || !fitsRight ? leftward : rightward) : fitsRight || !fitsLeft ? rightward : leftward;
		const top = pos.y + 2;
		this.dom.style.left = `${Math.max(4, Math.min(left, window.innerWidth - w - 4))}px`;
		this.dom.style.top = `${Math.max(4, Math.min(top, window.innerHeight - h - 4))}px`;
	}

	showAtMouseEvent(evt: MouseEvent) {
		return this.showAtPosition({ x: evt.clientX, y: evt.clientY }, evt.doc);
	}

	hide() {
		this.#used = true;
		if (!this.#shown) return this;
		this.#shown = false;
		if (this.#submenuTimer !== null) window.clearTimeout(this.#submenuTimer);
		this.closeSubmenu();
		this.#unwatch();
		globalApp()?.keymap.popScope(this.scope);
		this.dom.detach();
		this.#parentEl?.removeClass("has-active-menu");
		this.#visible[this.selected]?.dom.removeClass("selected");
		this.selected = -1;
		if (openMenu === this) openMenu = null;
		if (this.parentMenu?.currentSubmenu === this) this.parentMenu.currentSubmenu = null;
		this.unload();
		for (const cb of this.#onHide) cb();
		return this;
	}

	#unwatch() {
		for (const win of this.#watched) {
			win.document.removeEventListener("mousedown", this.#outside, true);
			win.removeEventListener("pagehide", this.#gone);
		}
		this.#watched = [];
	}

	close() {
		this.hide();
	}

	onHistoryBack() {
		this.hide();
	}

	onHide(cb: () => any) {
		this.#onHide.push(cb);
	}

	// One menu per event, shown at the pointer unless the caller shows or
	// hides it first.
	static forEvent(evt: PointerEvent | MouseEvent) {
		const cached = eventMenus.get(evt);
		if (cached) return cached;
		const menu = new Menu();
		eventMenus.set(evt, menu);
		window.setTimeout(() => {
			if (!menu.#used) menu.showAtMouseEvent(evt);
		});
		return menu;
	}
}
