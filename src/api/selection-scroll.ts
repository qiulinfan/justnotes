import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

// Scrolling while a selection is dragged past the top or bottom of what
// scrolls: much faster than CodeMirror's (about 7 lines a second at the
// edge), accelerating with the distance past the edge, one speed for the
// editor and rendered Markdown, scaled by the "Selection scroll speed"
// setting.

// The pointer starts scrolling this many px inside the edge, so a window
// whose note reaches the bottom of the screen still scrolls.
export const SCROLL_BAND = 10;

// Pixels per second for a pointer `past` px beyond the edge (negative
// inside it); `setting` is 1 to 10, default 5. At 5: about 1100 px/s at the
// edge, 3100 at 30 px past it, 12000 at 120 px (CodeMirror: 160, 570 and
// 1800; Chromium's reading view: 1300, 4900 and 11800). At 1 the edge speed
// is a little over CodeMirror's.
export function selectionScrollSpeed(past: number, setting: number): number {
	const d = past + SCROLL_BAND;
	if (d <= 0) return 0;
	return (setting / 5) * (600 + 50 * d + 0.3 * d * d);
}

// The signed speed (down is positive) for a pointer at `y` over a scroller
// whose visible part runs from `top` to `bottom`.
export function edgeVelocity(y: number, top: number, bottom: number, setting: number): number {
	if (y > bottom - SCROLL_BAND) return selectionScrollSpeed(y - bottom, setting);
	if (y < top + SCROLL_BAND) return -selectionScrollSpeed(top - y, setting);
	return 0;
}

// The part of `el` inside its window.
function visibleBox(el: HTMLElement) {
	const r = el.getBoundingClientRect();
	const win = el.ownerDocument.defaultView ?? window;
	return { left: r.left, right: r.right, top: Math.max(r.top, 0), bottom: Math.min(r.bottom, win.innerHeight) };
}

// Scrolls `el` once a frame while the pointer is at or past its top or
// bottom edge; `onScroll` runs after each frame that moved it.
class EdgeScroller {
	#pointer = { x: 0, y: 0 };
	#frame = 0;
	#last = 0;
	#carry = 0;

	constructor(
		readonly el: HTMLElement,
		readonly speed: () => number,
		readonly onScroll: (pointer: { x: number; y: number }, direction: number) => void,
	) {}

	get #win() {
		return this.el.ownerDocument.defaultView ?? window;
	}

	#velocity() {
		const box = visibleBox(this.el);
		return edgeVelocity(this.#pointer.y, box.top, box.bottom, this.speed());
	}

	move(x: number, y: number) {
		this.#pointer = { x, y };
		if (this.#frame || !this.#velocity()) return;
		this.#last = performance.now();
		this.#carry = 0;
		this.#frame = this.#win.requestAnimationFrame(this.#tick);
	}

	#tick = (now: number) => {
		const v = this.#velocity();
		if (!v) {
			this.#frame = 0;
			return;
		}
		// A frame that comes late (a busy page) does not jump far.
		const dt = Math.min(Math.max(now - this.#last, 0), 50) / 1000;
		this.#last = now;
		this.#carry += v * dt;
		const step = Math.trunc(this.#carry);
		if (step) {
			const before = this.el.scrollTop;
			this.el.scrollTop = before + step;
			this.#carry -= step;
			if (this.el.scrollTop !== before) this.onScroll(this.#pointer, Math.sign(v));
			else this.#carry = 0;
		}
		this.#frame = this.#win.requestAnimationFrame(this.#tick);
	};

	stop() {
		if (this.#frame) this.#win.cancelAnimationFrame(this.#frame);
		this.#frame = 0;
	}
}

// CodeMirror's mouse selection (view.inputState.mouseSelection, internal to
// @codemirror/view 6) keeps selecting; its own vertical scrolling (a 50 ms
// interval at 0.7 px per px past the edge + 8 px) is turned off and this
// scroller extends the selection through its `select(lastEvent)`, as its
// own scroll step does. Horizontal scrolling stays CodeMirror's.
interface MouseSelection {
	dragging: boolean | null;
	lastEvent: MouseEvent;
	scrollParents?: { y: HTMLElement | null };
	setScrollSpeed(x: number, y: number): void;
	select(event: MouseEvent): void;
}

function mouseSelectionOf(view: EditorView): MouseSelection | null {
	const ms = (view as any).inputState?.mouseSelection;
	return ms && typeof ms.select === "function" && typeof ms.setScrollSpeed === "function" ? ms : null;
}

export function editorSelectionScroll(speed: () => number): Extension {
	return ViewPlugin.fromClass(
		class {
			#selection: MouseSelection | null = null;
			#scroller: EdgeScroller | null = null;
			#doc: Document | null = null;

			constructor(readonly view: EditorView) {}

			begin() {
				this.end();
				const doc = this.view.dom.ownerDocument;
				this.#doc = doc;
				// Capture, so a move reaches this before CodeMirror's own listener.
				doc.addEventListener("mousemove", this.#move, true);
				doc.addEventListener("mouseup", this.end, true);
				doc.defaultView?.addEventListener("blur", this.end);
			}

			#move = (evt: MouseEvent) => {
				const ms = mouseSelectionOf(this.view);
				if (!ms || !(evt.buttons & 1)) return this.end();
				if (ms !== this.#selection) {
					this.#selection = ms;
					const own = ms.setScrollSpeed;
					own.call(ms, 0, 0);
					ms.setScrollSpeed = (x: number) => own.call(ms, x, 0);
					this.#scroller?.stop();
					this.#scroller = new EdgeScroller(ms.scrollParents?.y ?? this.view.scrollDOM, speed, () => {
						if (mouseSelectionOf(this.view) === ms && !ms.dragging) ms.select(ms.lastEvent);
					});
				}
				// Dragging the selected text is the browser's drag and drop.
				if (ms.dragging) this.#scroller?.stop();
				else this.#scroller?.move(evt.clientX, evt.clientY);
			};

			end = () => {
				this.#scroller?.stop();
				this.#scroller = null;
				this.#selection = null;
				if (!this.#doc) return;
				this.#doc.removeEventListener("mousemove", this.#move, true);
				this.#doc.removeEventListener("mouseup", this.end, true);
				this.#doc.defaultView?.removeEventListener("blur", this.end);
				this.#doc = null;
			};

			destroy() {
				this.end();
			}
		},
		{
			eventObservers: {
				mousedown(evt) {
					if (evt.button === 0) this.begin();
				},
			},
		},
	);
}

function scrollParent(el: Element | null): HTMLElement | null {
	for (let cur = el; cur; cur = cur.parentElement) {
		if (!(cur instanceof cur.ownerDocument.defaultView!.HTMLElement)) continue;
		if (cur.scrollHeight > cur.clientHeight && /auto|scroll/.test(getComputedStyle(cur).overflowY)) return cur;
	}
	return null;
}

// Native selection in rendered Markdown outside editors (the reading view,
// hover previews, embeds in other views). While such a drag is under way its
// scroller gets `is-selection-scrolling` (overflow-y hidden), which keeps
// Chromium's own autoscroll off it; this scroller moves it instead and
// extends the selection to the text at the edge after each step.
export function installNativeSelectionScroll(win: Window, speed: () => number) {
	const doc = win.document;
	doc.addEventListener(
		"mousedown",
		(evt) => {
			const target = evt.target as Element | null;
			if (evt.button !== 0 || !target?.closest || !target.closest(".markdown-rendered") || target.closest(".cm-editor, input, textarea, select, [contenteditable]")) return;
			const el = scrollParent(target);
			if (!el) return;
			// A press on the scroller's own scrollbar.
			const r = el.getBoundingClientRect();
			if (evt.clientX >= r.left + el.clientLeft + el.clientWidth || evt.clientY >= r.top + el.clientTop + el.clientHeight) return;
			const start = { x: evt.clientX, y: evt.clientY };
			let active = false;
			const scroller = new EdgeScroller(el, speed, (pointer, direction) => {
				const sel = doc.getSelection();
				if (!sel?.rangeCount) return;
				const box = visibleBox(el);
				const x = Math.min(Math.max(pointer.x, box.left + 1), box.right - 1);
				const y = direction > 0 ? box.bottom - 2 : box.top + 2;
				const pos = doc.caretPositionFromPoint?.(x, y);
				if (pos && el.contains(pos.offsetNode)) sel.extend(pos.offsetNode, pos.offset);
			});
			const move = (e: MouseEvent) => {
				if (!(e.buttons & 1)) return end();
				if (!active) {
					if (Math.max(Math.abs(e.clientX - start.x), Math.abs(e.clientY - start.y)) < 4 || doc.getSelection()?.isCollapsed !== false) return;
					active = true;
					el.addClass("is-selection-scrolling");
				}
				scroller.move(e.clientX, e.clientY);
			};
			const end = () => {
				scroller.stop();
				el.removeClass("is-selection-scrolling");
				doc.removeEventListener("mousemove", move, true);
				doc.removeEventListener("mouseup", end, true);
				doc.removeEventListener("dragstart", end, true);
				win.removeEventListener("blur", end);
			};
			doc.addEventListener("mousemove", move, true);
			doc.addEventListener("mouseup", end, true);
			doc.addEventListener("dragstart", end, true);
			win.addEventListener("blur", end);
		},
		true,
	);
}
