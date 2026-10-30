export interface EventRef {
	e: Events;
	name: string;
	fn: (...args: any[]) => any;
	ctx?: any;
}

export class Events {
	_: Record<string, EventRef[]> = {};

	on(name: string, fn: (...args: any[]) => any, ctx?: any): EventRef {
		const ref: EventRef = { e: this, name, fn, ctx };
		(this._[name] ??= []).push(ref);
		return ref;
	}

	off(name: string, fn: (...args: any[]) => any) {
		const list = this._[name];
		if (list) this._[name] = list.filter((r) => r.fn !== fn);
	}

	offref(ref: EventRef) {
		const list = this._[ref.name];
		if (list) list.remove(ref);
	}

	trigger(name: string, ...data: any[]) {
		for (const ref of [...(this._[name] ?? [])]) this.tryTrigger(ref, data);
	}

	tryTrigger(ref: EventRef, args: any[]) {
		try {
			ref.fn.apply(ref.ctx, args);
		} catch (err) {
			console.error(err);
		}
	}
}

export class Component {
	_loaded = false;
	_children: Component[] = [];
	_events: (() => any)[] = [];

	load() {
		if (this._loaded) return;
		this._loaded = true;
		this.onload();
		for (const child of [...this._children]) child.load();
	}

	onload() {}

	unload() {
		if (!this._loaded) return;
		this._loaded = false;
		for (const child of [...this._children].reverse()) child.unload();
		this._children = [];
		for (const cb of this._events.splice(0).reverse()) {
			try {
				cb();
			} catch (err) {
				console.error(err);
			}
		}
		this.onunload();
	}

	onunload() {}

	addChild<T extends Component>(component: T): T {
		this._children.push(component);
		if (this._loaded) component.load();
		return component;
	}

	removeChild<T extends Component>(component: T): T {
		if (this._children.includes(component)) {
			this._children.remove(component);
			component.unload();
		}
		return component;
	}

	register(cb: () => any) {
		this._events.push(cb);
	}

	registerEvent(ref: EventRef) {
		this.register(() => ref.e.offref(ref));
	}

	registerDomEvent(el: EventTarget, type: string, cb: (ev: any) => any, options?: boolean | AddEventListenerOptions) {
		el.addEventListener(type, cb, options);
		this.register(() => el.removeEventListener(type, cb, options));
	}

	registerScopeEvent(handler: { scope: { unregister(h: any): void } }) {
		this.register(() => handler.scope.unregister(handler));
	}

	registerInterval(id: number) {
		this.register(() => clearInterval(id));
		return id;
	}
}
