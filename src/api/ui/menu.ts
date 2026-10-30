import { Component } from "../events";
import { setIcon } from "../icons";

export class MenuItem {
	dom: HTMLElement;
	iconEl: HTMLElement;
	titleEl: HTMLElement;
	section = "";
	callback: ((evt: MouseEvent | KeyboardEvent) => any) | null = null;
	disabled = false;
	#menu: Menu;
	submenu: Menu | null = null;

	constructor(menu: Menu) {
		this.#menu = menu;
		this.dom = createDiv("menu-item");
		this.iconEl = this.dom.createDiv("menu-item-icon");
		this.titleEl = this.dom.createDiv("menu-item-title");
		this.dom.addEventListener("click", (evt) => {
			if (this.disabled) return;
			if (this.submenu) {
				const r = this.dom.getBoundingClientRect();
				this.submenu.showAtPosition({ x: r.right, y: r.top });
				return;
			}
			this.#menu.hide();
			this.callback?.(evt);
		});
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

	setChecked(checked: boolean | null) {
		this.dom.toggleClass("mod-checked", !!checked);
		return this;
	}

	setDisabled(disabled: boolean) {
		this.disabled = disabled;
		this.dom.toggleClass("is-disabled", disabled);
		return this;
	}

	setWarning(warning: boolean) {
		this.dom.toggleClass("mod-warning", warning);
		return this;
	}

	setIsLabel(isLabel: boolean) {
		this.dom.toggleClass("is-label", isLabel);
		return this;
	}

	setSection(section: string) {
		this.section = section;
		return this;
	}

	setSubmenu() {
		this.submenu = new Menu();
		this.dom.addClass("has-submenu");
		return this.submenu;
	}

	onClick(cb: (evt: MouseEvent | KeyboardEvent) => any) {
		this.callback = cb;
		return this;
	}
}

let openMenu: Menu | null = null;

export class Menu extends Component {
	dom: HTMLElement;
	items: (MenuItem | "separator")[] = [];
	#onHide: (() => any)[] = [];
	#outside = (evt: MouseEvent) => {
		if (!this.dom.contains(evt.target as Node)) this.hide();
	};
	#key = (evt: KeyboardEvent) => {
		if (evt.key === "Escape") this.hide();
	};

	constructor() {
		super();
		this.dom = createDiv("menu");
	}

	setNoIcon() {
		this.dom.addClass("mod-no-icon");
		return this;
	}

	setUseNativeMenu(_useNative: boolean) {
		return this;
	}

	addItem(cb: (item: MenuItem) => any) {
		const item = new MenuItem(this);
		cb(item);
		this.items.push(item);
		return this;
	}

	addSeparator() {
		this.items.push("separator");
		return this;
	}

	#render() {
		this.dom.empty();
		// Items group by section in first-seen order, as in Obsidian.
		const sections: string[] = [];
		for (const i of this.items) if (i !== "separator" && !sections.includes(i.section)) sections.push(i.section);
		let first = true;
		for (const section of sections) {
			if (!first) this.dom.createDiv("menu-separator");
			first = false;
			for (const i of this.items) {
				if (i === "separator") continue;
				if (i.section === section) this.dom.appendChild(i.dom);
			}
		}
	}

	showAtPosition(pos: { x: number; y: number }) {
		if (openMenu && openMenu !== this) openMenu.hide();
		openMenu = this;
		this.#render();
		document.body.appendChild(this.dom);
		const { innerWidth, innerHeight } = window;
		const r = this.dom.getBoundingClientRect();
		this.dom.style.left = `${Math.min(pos.x, innerWidth - r.width - 4)}px`;
		this.dom.style.top = `${Math.min(pos.y, innerHeight - r.height - 4)}px`;
		setTimeout(() => {
			document.addEventListener("mousedown", this.#outside, true);
			document.addEventListener("keydown", this.#key, true);
		});
		this.load();
		return this;
	}

	showAtMouseEvent(evt: MouseEvent) {
		return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
	}

	hide() {
		document.removeEventListener("mousedown", this.#outside, true);
		document.removeEventListener("keydown", this.#key, true);
		this.dom.detach();
		if (openMenu === this) openMenu = null;
		this.unload();
		for (const cb of this.#onHide) cb();
		return this;
	}

	close() {
		this.hide();
	}

	onHide(cb: () => any) {
		this.#onHide.push(cb);
	}

	static forEvent(evt: MouseEvent) {
		const menu = new Menu();
		setTimeout(() => menu.showAtMouseEvent(evt));
		return menu;
	}
}
