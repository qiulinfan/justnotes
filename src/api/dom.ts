// Obsidian augments built-in prototypes and globals (see `declare global` in
// obsidian.d.ts). Plugins call these everywhere, so they must exist before any
// plugin code runs.

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

function setAttr(el: Element, name: string, value: string | number | boolean | null) {
	if (value === null || value === false) el.removeAttribute(name);
	else el.setAttribute(name, value === true ? "" : String(value));
}

function applyInfo(el: Element, o: Info | string | undefined, parent: Node | null) {
	const info: Info = typeof o === "string" ? { cls: o } : (o ?? {});
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
	const target = info.parent ?? parent;
	if (target) {
		if (info.prepend) target.insertBefore(el, target.firstChild);
		else target.appendChild(el);
	}
}

function makeEl(parent: Node | null, tag: string, o?: Info | string, cb?: (el: any) => void) {
	const el = document.createElement(tag);
	applyInfo(el, o, parent);
	cb?.(el);
	return el;
}

function makeSvg(parent: Node | null, tag: string, o?: Info | string, cb?: (el: any) => void) {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	applyInfo(el, o, parent);
	cb?.(el);
	return el;
}

export function installDomExtensions() {
	const w = window as any;

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
			const i = this.indexOf(t);
			if (i >= 0) this.splice(i, 1);
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
		matchParent(selector: string, lastParent?: Element) {
			let el: Element | null = this;
			while (el && el !== lastParent) {
				if (el.matches(selector)) return el;
				el = el.parentElement;
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
			this.style.display = "";
		},
		hide() {
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
			// Obsidian detects insertion with a CSS animation hook; observing the
			// document is the closest equivalent without that stylesheet trick.
			const observer = new MutationObserver(() => {
				if (this.isConnected) {
					if (once) observer.disconnect();
					listener();
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			return () => observer.disconnect();
		},
		onWindowMigrated() {
			return () => {};
		},
		trigger(eventType: string) {
			this.dispatchEvent(new Event(eventType));
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
		ajax(opts: any) {
			ajaxPromise(opts).then(
				(r) => opts.success?.(r, opts.req),
				(e) => opts.error?.(e, opts.req),
			);
		},
		ajaxPromise,
	});
}

async function ajaxPromise(opts: any) {
	const res = await fetch(opts.url, {
		method: opts.method ?? "GET",
		headers: opts.headers,
		body: typeof opts.data === "object" && !(opts.data instanceof ArrayBuffer) ? JSON.stringify(opts.data) : opts.data,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}
