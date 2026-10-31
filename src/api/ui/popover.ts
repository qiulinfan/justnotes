import { AppResizeObserver } from "../dom";
import { Component } from "../events";

export interface HoverParent {
	hoverPopover: HoverPopover | null;
}

export enum PopoverState {
	Showing,
	Shown,
	Hiding,
	Hidden,
}

// Popovers on screen; one shown for a link inside another is its child.
const shown: HoverPopover[] = [];

// A popover next to a hovered element. It appears after waitTime and goes
// once the pointer has left both the target and the popover (and any popover
// opened from inside it).
export class HoverPopover extends Component {
	hoverEl: HTMLElement;
	state = PopoverState.Showing;
	parent: HoverParent;
	targetEl: HTMLElement | null;
	#staticPos: { x: number; y: number } | null;
	#showTimer: number | null;
	#hideTimer: number | null = null;
	#doc: Document | null = null;
	#resize = new AppResizeObserver(() => this.#position());

	constructor(parent: HoverParent, targetEl: HTMLElement | null, waitTime = 300, staticPos: { x: number; y: number } | null = null) {
		super();
		this.parent = parent;
		this.targetEl = targetEl;
		this.#staticPos = staticPos;
		this.hoverEl = createDiv("popover hover-popover");
		parent.hoverPopover?.hide();
		parent.hoverPopover = this;
		for (const el of [targetEl, this.hoverEl]) {
			el?.addEventListener("mouseenter", this.#onEnter);
			el?.addEventListener("mouseleave", this.#onLeave);
		}
		this.#showTimer = window.setTimeout(() => this.#show(), waitTime);
	}

	hide() {
		if (this.state === PopoverState.Hidden) return;
		this.state = PopoverState.Hidden;
		if (this.#showTimer !== null) window.clearTimeout(this.#showTimer);
		if (this.#hideTimer !== null) window.clearTimeout(this.#hideTimer);
		for (const child of shown.filter((p) => p.#isChildOf(this))) child.hide();
		shown.remove(this);
		this.#resize.disconnect();
		this.targetEl?.removeEventListener("mouseenter", this.#onEnter);
		this.targetEl?.removeEventListener("mouseleave", this.#onLeave);
		this.#doc?.removeEventListener("mousedown", this.#onOutside, true);
		this.#doc?.removeEventListener("keydown", this.#onKey, true);
		this.hoverEl.detach();
		if (this.parent.hoverPopover === this) this.parent.hoverPopover = null;
		this.unload();
		for (const owner of shown) if (this.#isChildOf(owner)) owner.#scheduleHide();
	}

	#show() {
		this.#showTimer = null;
		if (this.state !== PopoverState.Showing) return;
		if (this.targetEl && !this.targetEl.isConnected) return this.hide();
		// In the target's window, a popout included.
		const doc = this.targetEl?.doc ?? activeDocument;
		this.#doc = doc;
		doc.body.appendChild(this.hoverEl);
		this.state = PopoverState.Shown;
		shown.push(this);
		this.#position();
		this.#resize.observe(this.hoverEl);
		doc.addEventListener("mousedown", this.#onOutside, true);
		doc.addEventListener("keydown", this.#onKey, true);
		this.load();
	}

	// Below the target, or above it when there is no room; inside the window.
	#position() {
		const el = this.hoverEl;
		const window = el.win;
		const box = el.getBoundingClientRect();
		let { x, y } = this.#staticPos ?? { x: 0, y: 0 };
		if (!this.#staticPos && this.targetEl) {
			const r = this.targetEl.getBoundingClientRect();
			x = r.left;
			y = r.bottom + 4;
			if (y + box.height > window.innerHeight - 8 && r.top - box.height - 4 > 8) y = r.top - box.height - 4;
		}
		el.style.left = `${Math.clamp(x, 8, Math.max(8, window.innerWidth - box.width - 8))}px`;
		el.style.top = `${Math.clamp(y, 8, Math.max(8, window.innerHeight - box.height - 8))}px`;
	}

	#isChildOf(other: HoverPopover) {
		return !!this.targetEl && other !== this && other.hoverEl.contains(this.targetEl);
	}

	#isHovered(): boolean {
		return this.hoverEl.matches(":hover") || !!this.targetEl?.matches(":hover") || shown.some((p) => p.#isChildOf(this) && p.#isHovered());
	}

	#scheduleHide() {
		if (this.#hideTimer !== null) window.clearTimeout(this.#hideTimer);
		this.#hideTimer = window.setTimeout(() => {
			this.#hideTimer = null;
			if (!this.#isHovered()) this.hide();
		}, 300);
	}

	#onEnter = () => {
		if (this.#hideTimer !== null) window.clearTimeout(this.#hideTimer);
		this.#hideTimer = null;
	};

	#onLeave = () => {
		// Leaving the target before the popover appeared cancels it.
		if (this.state === PopoverState.Showing) this.hide();
		else this.#scheduleHide();
	};

	#onOutside = (evt: MouseEvent) => {
		const inside = (p: HoverPopover): boolean => p.hoverEl.contains(evt.target as Node) || shown.some((c) => c.#isChildOf(p) && inside(c));
		if (!inside(this)) this.hide();
	};

	#onKey = (evt: KeyboardEvent) => {
		if (evt.key === "Escape") this.hide();
	};
}
