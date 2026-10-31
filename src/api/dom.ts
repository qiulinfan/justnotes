// Obsidian augments built-in prototypes and globals (see `declare global` in
// obsidian.d.ts). Plugins call these everywhere, so they must exist before any
// plugin code runs.
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

function makeEl(parent: Node | null, tag: string, o?: Info | string, cb?: (el: any) => void) {
	return build(document.createElement(tag), parent, o, cb);
}

function makeSvg(parent: Node | null, tag: string, o?: Info | string, cb?: (el: any) => void) {
	return build(document.createElementNS("http://www.w3.org/2000/svg", tag), parent, o, cb);
}

// Obsidian's renderer hands plugins Electron's module with @electron/remote as
// `remote`, both from require("electron") and as window.electron. `remote` is
// an own property of Electron's module object, so every require("electron")
// sees it, including esbuild's `import * as electron`, which copies own
// properties. @electron/remote loads through the page's require, so a plugin
// that requires it directly gets the same instance. Set up on first use: it
// needs the Electron renderer.
// Electron 45's renderer has no `clipboard`, which Obsidian's renderer still
// has; plugins read and write it synchronously, as the main process's
// clipboard does through remote.
let electronModule: any;
export function getElectron() {
	if (!electronModule) {
		electronModule = require("electron");
		const fromRemote: Record<string, () => unknown> = {
			remote: () => (window as any).require("@electron/remote"),
			clipboard: () => (window as any).require("@electron/remote").clipboard,
		};
		for (const [name, get] of Object.entries(fromRemote)) {
			if (!(name in electronModule)) Object.defineProperty(electronModule, name, { get, enumerable: true, configurable: true });
		}
	}
	return electronModule;
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
	if (insertionWatches.size === 0) {
		insertionObserver?.disconnect();
		insertionObserver = null;
	}
}

function watchInsertion(watch: InsertionWatch) {
	insertionWatches.add(watch);
	if (!insertionObserver) {
		insertionObserver = new MutationObserver(checkInsertions);
		insertionObserver.observe(document.documentElement, { childList: true, subtree: true });
	}
	queueMicrotask(checkInsertions);
	return () => {
		insertionWatches.delete(watch);
		if (insertionWatches.size === 0) checkInsertions();
	};
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

export function installDomExtensions() {
	const w = window as any;
	installLanguageExtensions();

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
			this.appendChild(document.createTextNode(val));
		},
		instanceOf(type: any) {
			return this instanceof type;
		},
		createEl(tag: string, o?: Info | string, cb?: (el: any) => void) {
			return makeEl(this, tag, o, cb);
		},
		createDiv(o?: Info | string, cb?: (el: any) => void) {
			return makeEl(this, "div", o, cb);
		},
		createSpan(o?: Info | string, cb?: (el: any) => void) {
			return makeEl(this, "span", o, cb);
		},
		createSvg(tag: string, o?: Info | string, cb?: (el: any) => void) {
			return makeSvg(this, tag, o, cb);
		},
	});
	for (const key of ["doc", "win", "constructorWin"]) {
		Object.defineProperty(Node.prototype, key, {
			configurable: true,
			get() {
				return key === "doc" ? (this.ownerDocument ?? document) : window;
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
			return getComputedStyle(this, pseudo).getPropertyValue(property);
		},
		isActiveElement() {
			return this === document.activeElement;
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
		onWindowMigrated() {
			return () => {};
		},
		trigger(eventType: string) {
			this.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
		},
	});
	for (const key of ["innerWidth", "innerHeight"]) {
		Object.defineProperty(HTMLElement.prototype, key, {
			configurable: true,
			get() {
				const style = getComputedStyle(this);
				return key === "innerWidth"
					? this.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
					: this.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
			},
		});
	}
	define(UIEvent.prototype, {
		instanceOf(type: any) {
			return this instanceof type;
		},
	});
	for (const [key, get] of [
		["targetNode", (e: Event) => e.target as Node],
		["win", () => window],
		["doc", () => document],
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
		fish: (s: string) => document.querySelector(s),
		fishAll: (s: string) => Array.from(document.querySelectorAll(s)),
		createEl: (tag: string, o?: Info | string, cb?: (el: any) => void) => makeEl(null, tag, o, cb),
		createDiv: (o?: Info | string, cb?: (el: any) => void) => makeEl(null, "div", o, cb),
		createSpan: (o?: Info | string, cb?: (el: any) => void) => makeEl(null, "span", o, cb),
		createSvg: (tag: string, o?: Info | string, cb?: (el: any) => void) => makeSvg(null, tag, o, cb),
		createFragment(cb?: (el: DocumentFragment) => void) {
			const frag = document.createDocumentFragment();
			cb?.(frag);
			return frag;
		},
		sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
		nextFrame: () => new Promise((r) => requestAnimationFrame(() => r(undefined))),
		ready: (fn: () => any) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn()),
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
