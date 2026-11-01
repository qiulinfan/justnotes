// Obsidian augments built-in prototypes and globals (see `declare global` in
// obsidian.d.ts). Plugins call these everywhere, so they must exist before any
// plugin code runs.
import type { NativeImage } from "electron";
import type { ClipboardReply } from "../main/ipc";
import { moment } from "./util";

type Info = {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	parent?: Node;
	value?: string;
	type?: string;
	prepend?: boolean;
	placeholder?: string;
	href?: string;
};

function define(target: object, props: Record<string, any> & ThisType<any>) {
	for (const [key, value] of Object.entries(props)) {
		Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
	}
}

// Only null removes an attribute; other values are written as strings, so
// `{ spellcheck: false }` sets spellcheck="false".
function setAttr(el: Element, name: string, value: string | number | boolean | null | undefined) {
	if (value === null || value === undefined) el.removeAttribute(name);
	else el.setAttribute(name, String(value));
}

function applyInfo(el: Element, info: Info) {
	if (info.cls) {
		const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(" ");
		el.classList.add(...classes.filter(Boolean));
	}
	if (info.text !== undefined) (el as any).setText(info.text);
	if (info.attr) for (const [k, v] of Object.entries(info.attr)) setAttr(el, k, v);
	if (info.title !== undefined) (el as any).title = info.title;
	if (info.value !== undefined) (el as any).value = info.value;
	if (info.type !== undefined) (el as any).type = info.type;
	if (info.placeholder !== undefined) (el as any).placeholder = info.placeholder;
	if (info.href !== undefined) (el as any).href = info.href;
}

// The callback sees the element before it is inserted, as the d.ts promises.
function build<T extends Element>(el: T, parent: Node | null, o: Info | string | undefined, cb?: (el: T) => void) {
	const info: Info = typeof o === "string" ? { cls: o } : (o ?? {});
	applyInfo(el, info);
	cb?.(el);
	const target = info.parent ?? parent;
	if (target) {
		if (info.prepend) target.insertBefore(el, target.firstChild);
		else target.appendChild(el);
	}
	return el;
}

// The document a node lives in (a document is its own). Elements created
// through a parent's createEl/createDiv belong to the parent's window, as in
// Obsidian, so a view moved to a popout window keeps making its own elements.
function docOf(node: Node | null): Document {
	if (!node) return document;
	return node.nodeType === 9 ? (node as Document) : (node.ownerDocument ?? document);
}

function makeEl(doc: Document, parent: Node | null, tag: string, o?: Info | string, cb?: (el: any) => void) {
	return build(doc.createElement(tag), parent, o, cb);
}

function makeSvg(doc: Document, parent: Node | null, tag: string, o?: Info | string, cb?: (el: any) => void) {
	return build(doc.createElementNS("http://www.w3.org/2000/svg", tag), parent, o, cb);
}

// The app's windows: the vault window first, then its popout windows. Code
// that listens to a window's events registers with onWindowAdded to listen in
// popouts too.
const popouts: Window[] = [];
const windowAdded: ((win: Window) => void)[] = [];

export function appWindows(): Window[] {
	return [window, ...popouts];
}

// Runs `install` for every popout window added from now on.
export function onWindowAdded(install: (win: Window) => void) {
	windowAdded.push(install);
}

// A popout window joins the app: its realm gets Obsidian's DOM augmentations
// (elements made from its document use its constructors) and every installer.
export function addWindow(win: Window) {
	if (popouts.includes(win)) return;
	popouts.push(win);
	installDomExtensions(win);
	if (insertionObserver) insertionObserver.observe(win.document.documentElement, { childList: true, subtree: true });
	for (const install of windowAdded) {
		try {
			install(win);
		} catch (err) {
			console.error(err);
		}
	}
}

export function removeWindow(win: Window) {
	popouts.remove(win);
	if (activeWindowOf() === win) setActiveWindow(window);
}

function activeWindowOf(): Window {
	return (window as any).activeWindow ?? window;
}

// activeWindow and activeDocument follow the focused app window.
export function setActiveWindow(win: Window) {
	const w = window as any;
	w.activeWindow = win;
	w.activeDocument = win.document;
}

// The window whose constructors made a node: a node keeps its realm when it
// moves to another window's document.
function constructorWinOf(node: Node): Window {
	for (const win of appWindows()) if (node instanceof (win as any).Node) return win;
	return window;
}

// instanceof across the app's windows: `type` is one window's DOM class and
// the object is an instance of the class of that name in its own realm.
function crossInstanceOf(obj: object, type: any): boolean {
	if (obj instanceof type) return true;
	const name = type?.name;
	if (!name) return false;
	const wins = appWindows() as any[];
	return wins.some((w) => w[name] === type) && wins.some((w) => typeof w[name] === "function" && obj instanceof w[name]);
}

interface MigrationWatch {
	el: HTMLElement;
	win: Window;
	listener: (win: Window) => any;
}

// onWindowMigrated registrations; checked whenever a document's tree changes.
const migrationWatches = new Set<MigrationWatch>();

function checkMigrations() {
	for (const watch of [...migrationWatches]) {
		if (!watch.el.isConnected) continue;
		const win = watch.el.ownerDocument.defaultView;
		if (!win || win === watch.win) continue;
		watch.win = win;
		try {
			watch.listener(win);
		} catch (err) {
			console.error(err);
		}
	}
}

// Obsidian's renderer hands plugins Electron's module with @electron/remote as
// `remote`, both from require("electron") and as window.electron. `remote` is
// an own property of Electron's module object, so every require("electron")
// sees it, including esbuild's `import * as electron`, which copies own
// properties. @electron/remote loads through the page's require, so a plugin
// that requires it directly gets the same instance. Set up on first use: it
// needs the Electron renderer.
let electronModule: any;
export function getElectron() {
	if (!electronModule) {
		electronModule = require("electron");
		let clipboard: unknown;
		const added: Record<string, () => unknown> = {
			remote: () => (window as any).require("@electron/remote"),
			clipboard: () => (clipboard ??= syncClipboard(electronModule)),
		};
		for (const [name, get] of Object.entries(added)) {
			if (!(name in electronModule)) Object.defineProperty(electronModule, name, { get, enumerable: true, configurable: true });
		}
	}
	return electronModule;
}

// This Electron's renderer has no `clipboard`, which Obsidian's renderer still
// has: Electron's old synchronous one, which plugins read and write as such
// (latex-live reads a copied table's text and HTML in one go). The main
// process's clipboard is asynchronous, so each call waits for it on sendSync
// (main/ipc.ts). Images cross as PNG bytes.
function syncClipboard(electron: any) {
	const call = (method: string, ...args: unknown[]): any => {
		const reply: ClipboardReply = electron.ipcRenderer.sendSync("justnotes:clipboard", method, ...args);
		if ("error" in reply) throw new Error(reply.error);
		return reply.value;
	};
	return {
		readText: (): string => call("readText"),
		writeText: (text: string) => void call("writeText", text),
		readHTML: (): string => call("readHTML"),
		writeHTML: (markup: string) => void call("writeHTML", markup),
		readImage: (): NativeImage => {
			const png: Uint8Array | null = call("readImage");
			return png ? electron.nativeImage.createFromBuffer(Buffer.from(png)) : electron.nativeImage.createEmpty();
		},
		writeImage: (image: NativeImage) => void call("writeImage", image.toPNG()),
		availableFormats: (): string[] => call("availableFormats"),
		has: (format: string): boolean => call("has", format),
		clear: () => void call("clear"),
	};
}

interface InsertionWatch {
	el: Element;
	listener: () => any;
	once: boolean;
	connected: boolean;
}

// One observer serves every onNodeInserted registration; a listener fires when
// its element goes from detached to connected (an element that is already
// connected counts as just inserted, like a CSS animationstart hook).
const insertionWatches = new Set<InsertionWatch>();
let insertionObserver: MutationObserver | null = null;

function checkInsertions() {
	checkMigrations();
	for (const watch of [...insertionWatches]) {
		const connected = watch.el.isConnected;
		if (connected && !watch.connected) {
			if (watch.once) insertionWatches.delete(watch);
			try {
				watch.listener();
			} catch (err) {
				console.error(err);
			}
		}
		watch.connected = connected;
	}
	if (insertionWatches.size === 0 && migrationWatches.size === 0) {
		insertionObserver?.disconnect();
		insertionObserver = null;
	}
}

// One observer over every app window's document.
function observeTrees() {
	if (insertionObserver) return;
	insertionObserver = new MutationObserver(checkInsertions);
	for (const win of appWindows()) insertionObserver.observe(win.document.documentElement, { childList: true, subtree: true });
}

function watchInsertion(watch: InsertionWatch) {
	insertionWatches.add(watch);
	observeTrees();
	queueMicrotask(checkInsertions);
	return () => {
		insertionWatches.delete(watch);
		if (insertionWatches.size === 0) checkInsertions();
	};
}

function watchMigration(watch: MigrationWatch) {
	migrationWatches.add(watch);
	observeTrees();
	return () => {
		migrationWatches.delete(watch);
	};
}

// A ResizeObserver whose targets may sit in any app window. An observer sees
// only elements of its own window's document, so each target is observed by
// the observer of the window it is in, again after it moves to another one.
export class AppResizeObserver {
	#callback: ResizeObserverCallback;
	#observers = new Map<Window, ResizeObserver>();
	#targets = new Map<HTMLElement, { win: Window; stop: () => void }>();

	constructor(callback: ResizeObserverCallback) {
		this.#callback = callback;
	}

	observe(el: HTMLElement) {
		if (this.#targets.has(el)) return;
		const target = { win: el.win, stop: () => {} };
		this.#targets.set(el, target);
		this.#observer(target.win).observe(el);
		target.stop = el.onWindowMigrated((win) => {
			this.#observers.get(target.win)?.unobserve(el);
			target.win = win;
			this.#observer(win).observe(el);
		});
	}

	unobserve(el: HTMLElement) {
		const target = this.#targets.get(el);
		if (!target) return;
		this.#targets.delete(el);
		target.stop();
		this.#observers.get(target.win)?.unobserve(el);
	}

	disconnect() {
		for (const target of this.#targets.values()) target.stop();
		this.#targets.clear();
		for (const observer of this.#observers.values()) observer.disconnect();
		this.#observers.clear();
	}

	#observer(win: Window) {
		let observer = this.#observers.get(win);
		if (!observer) {
			observer = new (win as unknown as typeof globalThis).ResizeObserver((entries, o) => this.#callback(entries, o));
			this.#observers.set(win, observer);
		}
		return observer;
	}
}

// The inline display an element had before hide(), restored by show().
const hiddenDisplay = new WeakMap<HTMLElement, string>();

// Language-level augmentations, which need no DOM.
export function installLanguageExtensions() {
	define(Object, {
		isEmpty: (o: object) => Object.keys(o).length === 0,
		each(o: Record<string, any>, cb: (v: any, k: string) => boolean | void, ctx?: any) {
			for (const k of Object.keys(o)) if (cb.call(ctx, o[k], k) === false) return false;
			return true;
		},
	});
	define(Array, { combine: (arrays: any[][]) => ([] as any[]).concat(...arrays) });
	define(Array.prototype, {
		first() {
			return this[0];
		},
		last() {
			return this[this.length - 1];
		},
		contains(t: any) {
			return this.includes(t);
		},
		remove(t: any) {
			for (let i = this.length - 1; i >= 0; i--) if (this[i] === t) this.splice(i, 1);
		},
		shuffle() {
			for (let i = this.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[this[i], this[j]] = [this[j], this[i]];
			}
			return this;
		},
		unique() {
			return [...new Set(this)];
		},
	});
	define(Math, {
		clamp: (v: number, min: number, max: number) => Math.min(max, Math.max(min, v)),
		square: (v: number) => v * v,
	});
	define(String, { isString: (o: any) => typeof o === "string" });
	define(String.prototype, {
		contains(t: string) {
			return this.includes(t);
		},
		format(...args: string[]) {
			return this.replace(/{(\d+)}/g, (m: string, i: string) => args[+i] ?? m);
		},
	});
	define(Number, { isNumber: (o: any) => typeof o === "number" });
}

// Installs the augmentations in a window's realm: the vault window at boot,
// each popout window when it opens.
export function installDomExtensions(win: Window = window) {
	const w = win as any;
	const main = win === window;
	if (main) installLanguageExtensions();
	const { Node, Element, Document, DocumentFragment, HTMLElement, UIEvent } = w as typeof globalThis;
	const doc = win.document;

	define(Node.prototype, {
		detach() {
			this.parentNode?.removeChild(this);
		},
		empty() {
			while (this.lastChild) this.removeChild(this.lastChild);
		},
		insertAfter(node: Node, child: Node | null) {
			this.insertBefore(node, child ? child.nextSibling : this.firstChild);
			return node;
		},
		indexOf(other: Node) {
			return Array.prototype.indexOf.call(this.childNodes, other);
		},
		setChildrenInPlace(children: Node[]) {
			const set = new Set(children);
			for (const c of [...this.childNodes]) if (!set.has(c)) this.removeChild(c);
			let cur = this.firstChild;
			for (const c of children) {
				if (c === cur) cur = cur.nextSibling;
				else this.insertBefore(c, cur);
			}
		},
		appendText(val: string) {
			this.appendChild(docOf(this).createTextNode(val));
		},
		instanceOf(type: any) {
			return crossInstanceOf(this, type);
		},
		createEl(tag: string, o?: Info | string, cb?: (el: any) => void) {
			return makeEl(docOf(this), this, tag, o, cb);
		},
		createDiv(o?: Info | string, cb?: (el: any) => void) {
			return makeEl(docOf(this), this, "div", o, cb);
		},
		createSpan(o?: Info | string, cb?: (el: any) => void) {
			return makeEl(docOf(this), this, "span", o, cb);
		},
		createSvg(tag: string, o?: Info | string, cb?: (el: any) => void) {
			return makeSvg(docOf(this), this, tag, o, cb);
		},
	});
	const nodeGetters: Record<string, (node: Node) => unknown> = {
		doc: (node) => docOf(node),
		win: (node) => docOf(node).defaultView ?? window,
		constructorWin: (node) => constructorWinOf(node),
	};
	for (const [key, get] of Object.entries(nodeGetters)) {
		Object.defineProperty(Node.prototype, key, {
			configurable: true,
			get() {
				return get(this);
			},
		});
	}

	define(Element.prototype, {
		getText() {
			return this.textContent ?? "";
		},
		setText(val: string | DocumentFragment) {
			if (typeof val === "string") this.textContent = val;
			else {
				this.empty();
				this.appendChild(val);
			}
		},
		addClass(...classes: string[]) {
			this.classList.add(...classes.filter(Boolean));
		},
		addClasses(classes: string[]) {
			this.classList.add(...classes.filter(Boolean));
		},
		removeClass(...classes: string[]) {
			this.classList.remove(...classes);
		},
		removeClasses(classes: string[]) {
			this.classList.remove(...classes);
		},
		toggleClass(classes: string | string[], value: boolean) {
			for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, value);
		},
		hasClass(cls: string) {
			return this.classList.contains(cls);
		},
		setAttr(name: string, value: any) {
			setAttr(this, name, value);
		},
		setAttrs(obj: Record<string, any>) {
			for (const [k, v] of Object.entries(obj)) setAttr(this, k, v);
		},
		getAttr(name: string) {
			return this.getAttribute(name);
		},
		// lastParent is the last ancestor tested, not excluded.
		matchParent(selector: string, lastParent?: Element) {
			for (let el: Element | null = this; el; el = el.parentElement) {
				if (el.matches(selector)) return el;
				if (el === lastParent) break;
			}
			return null;
		},
		getCssPropertyValue(property: string, pseudo?: string) {
			return this.win.getComputedStyle(this, pseudo).getPropertyValue(property);
		},
		isActiveElement() {
			return this === this.doc.activeElement;
		},
		find(selector: string) {
			return this.querySelector(selector);
		},
		findAll(selector: string) {
			return Array.from(this.querySelectorAll(selector));
		},
		findAllSelf(selector: string) {
			const all = Array.from(this.querySelectorAll(selector));
			if (this.matches(selector)) all.unshift(this);
			return all;
		},
		setCssStyles(styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		setCssProps(props: Record<string, string>) {
			for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
		},
	});
	define(DocumentFragment.prototype, {
		find(selector: string) {
			return this.querySelector(selector);
		},
		findAll(selector: string) {
			return Array.from(this.querySelectorAll(selector));
		},
	});

	const delegated = (target: any) => {
		target._EVENTS ??= {};
		return target._EVENTS;
	};
	const on = function (this: any, type: string, selector: string, listener: Function, options?: any) {
		const callback = (ev: Event) => {
			const t = ev.target as Element | null;
			const match = t?.closest?.(selector);
			if (match && this.contains(match)) listener.call(this, ev, match);
		};
		(delegated(this)[type] ??= []).push({ selector, listener, options, callback });
		this.addEventListener(type, callback, options);
	};
	const off = function (this: any, type: string, selector: string, listener: Function, options?: any) {
		const list: any[] = delegated(this)[type] ?? [];
		for (const info of list.filter((i) => i.selector === selector && i.listener === listener)) {
			this.removeEventListener(type, info.callback, options);
			list.remove(info);
		}
	};
	define(Document.prototype, { on, off });
	define(HTMLElement.prototype, {
		show() {
			if (this.style.display !== "none") return;
			this.style.display = hiddenDisplay.get(this) ?? "";
			hiddenDisplay.delete(this);
		},
		hide() {
			if (this.style.display === "none") return;
			hiddenDisplay.set(this, this.style.display);
			this.style.display = "none";
		},
		toggle(show: boolean) {
			show ? this.show() : this.hide();
		},
		toggleVisibility(visible: boolean) {
			this.style.visibility = visible ? "" : "hidden";
		},
		isShown() {
			return this.offsetParent !== null;
		},
		on,
		off,
		onClickEvent(listener: (ev: MouseEvent) => any, options?: any) {
			this.addEventListener("click", listener, options);
			this.addEventListener("auxclick", listener, options);
		},
		onNodeInserted(listener: () => any, once?: boolean) {
			return watchInsertion({ el: this, listener, once: !!once, connected: false });
		},
		// Fires when the element is moved into another window's document (a
		// leaf moved to or from a popout window).
		onWindowMigrated(listener: (win: Window) => any) {
			return watchMigration({ el: this, win: this.win, listener });
		},
		trigger(eventType: string) {
			this.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
		},
	});
	for (const key of ["innerWidth", "innerHeight"]) {
		Object.defineProperty(HTMLElement.prototype, key, {
			configurable: true,
			get() {
				const style = this.win.getComputedStyle(this);
				return key === "innerWidth"
					? this.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
					: this.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
			},
		});
	}
	define(UIEvent.prototype, {
		instanceOf(type: any) {
			return crossInstanceOf(this, type);
		},
	});
	const eventWin = (e: UIEvent) => e.view ?? ((e.target as Node | null)?.nodeType ? docOf(e.target as Node).defaultView : null) ?? window;
	for (const [key, get] of [
		["targetNode", (e: UIEvent) => e.target as Node],
		["win", eventWin],
		["doc", (e: UIEvent) => eventWin(e).document],
	] as const) {
		Object.defineProperty(UIEvent.prototype, key, {
			configurable: true,
			get() {
				return get(this);
			},
		});
	}

	Object.assign(w, {
		isBoolean: (o: any) => typeof o === "boolean",
		fish: (s: string) => activeWindowOf().document.querySelector(s),
		fishAll: (s: string) => Array.from(activeWindowOf().document.querySelectorAll(s)),
		createEl: (tag: string, o?: Info | string, cb?: (el: any) => void) => makeEl(doc, null, tag, o, cb),
		createDiv: (o?: Info | string, cb?: (el: any) => void) => makeEl(doc, null, "div", o, cb),
		createSpan: (o?: Info | string, cb?: (el: any) => void) => makeEl(doc, null, "span", o, cb),
		createSvg: (tag: string, o?: Info | string, cb?: (el: any) => void) => makeSvg(doc, null, tag, o, cb),
		createFragment(cb?: (el: DocumentFragment) => void) {
			const frag = doc.createDocumentFragment();
			cb?.(frag);
			return frag;
		},
		sleep: (ms: number) => new Promise((r) => win.setTimeout(r, ms)),
		nextFrame: () => new Promise((r) => win.requestAnimationFrame(() => r(undefined))),
		ready: (fn: () => any) => (doc.readyState === "loading" ? doc.addEventListener("DOMContentLoaded", fn) : fn()),
	});
	// Plugin code runs in the vault window's realm and reads its globals; a
	// popout's own globals forward to them.
	if (!main) {
		for (const key of ["activeWindow", "activeDocument"]) {
			Object.defineProperty(w, key, { configurable: true, get: () => (window as any)[key] });
		}
		return;
	}
	Object.assign(w, {
		activeWindow: window,
		activeDocument: document,
		ajax,
		ajaxPromise: (opts: AjaxOptions) =>
			new Promise((resolve, reject) => ajax(opts, resolve, (_err, req) => reject(req))),
		// Obsidian's bundled moment is also a global; plugins call window.moment().
		moment,
		electron: getElectron(),
	});
}

interface AjaxOptions {
	method?: string;
	url: string;
	success?: (response: any, req: XMLHttpRequest) => any;
	error?: (error: any, req: XMLHttpRequest) => any;
	data?: object | string | ArrayBuffer;
	headers?: Record<string, string>;
	withCredentials?: boolean;
	req?: XMLHttpRequest;
}

// Statuses 200-399 succeed; objects are sent as JSON; credentials default to
// on when there is a body.
function ajax(opts: AjaxOptions, resolve = opts.success, reject = opts.error) {
	const req = new XMLHttpRequest();
	opts.req = req;
	req.open(opts.method ?? "GET", opts.url, true);
	req.withCredentials = opts.withCredentials ?? opts.data !== undefined;
	const headers = opts.headers ?? {};
	for (const [name, value] of Object.entries(headers)) req.setRequestHeader(name, value);
	let body = opts.data;
	if (body !== undefined && typeof body !== "string" && !(body instanceof ArrayBuffer)) {
		body = JSON.stringify(body);
		if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) req.setRequestHeader("Content-Type", "application/json");
	}
	req.onload = () => {
		if (req.status >= 200 && req.status < 400) resolve?.(req.response, req);
		else reject?.(req.response, req);
	};
	req.onerror = (evt) => reject?.(evt, req);
	req.send(body as XMLHttpRequestBodyInit | undefined);
}
