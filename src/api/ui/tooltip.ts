import { onWindowAdded } from "../dom";

// One tooltip for the whole app, shown for any element with an
// aria-label after a hover delay, the way Obsidian shows its own tooltips.
// Plugins often set aria-label and data-tooltip-position directly instead of
// calling setTooltip, so hovering is watched globally (installTooltips).

export type TooltipPlacement = "bottom" | "right" | "left" | "top";

export interface TooltipOptions {
	placement?: TooltipPlacement;
	classes?: string[];
	gap?: number;
	delay?: number;
}

const DEFAULT_DELAY = 1000;
const DEFAULT_GAP = 8;
const MARGIN = 4;

let tooltipEl: HTMLElement | null = null;
let target: HTMLElement | null = null;
let showTimer: number | null = null;
let watchTimer: number | null = null;

export function setTooltip(el: HTMLElement, tooltip: string, options?: TooltipOptions) {
	if (!tooltip) {
		el.removeAttribute("aria-label");
		if (target === el) hideTooltip();
		return;
	}
	el.setAttribute("aria-label", tooltip);
	if (options?.placement) el.setAttribute("data-tooltip-position", options.placement);
	if (options?.classes?.length) el.setAttribute("data-tooltip-classes", options.classes.join(" "));
	if (options?.delay !== undefined) el.setAttribute("data-tooltip-delay", String(options.delay));
	if (options?.gap !== undefined) el.setAttribute("data-tooltip-gap", String(options.gap));
	if (target === el && tooltipEl?.isConnected) show(el, tooltip, optionsOf(el));
}

// Shows the tooltip over the element straight away, without a hover.
export function displayTooltip(newTargetEl: HTMLElement, content: string | DocumentFragment, options?: TooltipOptions) {
	clearShowTimer();
	target = newTargetEl;
	show(newTargetEl, content, { ...optionsOf(newTargetEl), ...options });
}

export function hideTooltip() {
	clearShowTimer();
	if (watchTimer !== null) window.clearInterval(watchTimer);
	watchTimer = null;
	target = null;
	tooltipEl?.detach();
}

// Called once at boot; popout windows get the same listeners.
export function installTooltips() {
	listen(window);
	onWindowAdded(listen);
}

function listen(win: Window) {
	const doc = win.document;
	doc.addEventListener("mouseover", onMouseOver, true);
	doc.addEventListener("mouseout", onMouseOut, true);
	for (const type of ["mousedown", "keydown", "wheel", "dragstart"]) doc.addEventListener(type, hideTooltip, true);
	win.addEventListener("blur", hideTooltip);
}

function optionsOf(el: HTMLElement): TooltipOptions {
	const position = el.getAttribute("data-tooltip-position") ?? el.getAttribute("aria-label-position");
	const delay = el.getAttribute("data-tooltip-delay") ?? el.getAttribute("aria-label-delay");
	const gap = el.getAttribute("data-tooltip-gap");
	const classes = el.getAttribute("data-tooltip-classes");
	return {
		placement: isPlacement(position) ? position : undefined,
		delay: delay !== null && delay !== "" ? Number(delay) : undefined,
		gap: gap !== null && gap !== "" ? Number(gap) : undefined,
		classes: classes ? classes.split(/\s+/).filter(Boolean) : undefined,
	};
}

function isPlacement(value: string | null): value is TooltipPlacement {
	return value === "bottom" || value === "right" || value === "left" || value === "top";
}

function onMouseOver(evt: MouseEvent) {
	const el = (evt.target as Element | null)?.closest?.("[aria-label]");
	if (!el?.instanceOf(HTMLElement) || el === target) return;
	const label = el.getAttribute("aria-label");
	if (!label) return;
	hideTooltip();
	target = el;
	const options = optionsOf(el);
	showTimer = window.setTimeout(() => {
		showTimer = null;
		const text = el.getAttribute("aria-label");
		if (target === el && el.isConnected && text) show(el, text, options);
	}, options.delay ?? DEFAULT_DELAY);
}

function onMouseOut(evt: MouseEvent) {
	if (!target) return;
	const to = evt.relatedTarget as Node | null;
	if (to && target.contains(to)) return;
	hideTooltip();
}

function clearShowTimer() {
	if (showTimer !== null) window.clearTimeout(showTimer);
	showTimer = null;
}

function show(el: HTMLElement, content: string | DocumentFragment, options: TooltipOptions) {
	tooltipEl ??= createDiv();
	const placement = options.placement ?? "bottom";
	tooltipEl.className = "tooltip";
	tooltipEl.addClasses(options.classes ?? []);
	if (placement !== "bottom") tooltipEl.addClass(`mod-${placement}`);
	tooltipEl.setText(content);
	tooltipEl.createDiv("tooltip-arrow");
	el.doc.body.appendChild(tooltipEl);
	position(tooltipEl, el.getBoundingClientRect(), placement, options.gap ?? DEFAULT_GAP);
	if (watchTimer === null) {
		// Hide when the target leaves the DOM, e.g. a re-rendered button.
		watchTimer = window.setInterval(() => {
			if (!target?.isConnected) hideTooltip();
		}, 300);
	}
}

function position(el: HTMLElement, r: DOMRect, placement: TooltipPlacement, gap: number) {
	const window = el.win;
	const w = el.offsetWidth;
	const h = el.offsetHeight;
	let side = placement;
	// Flip to the opposite side when the preferred one has no room.
	if (side === "top" && r.top - gap - h < MARGIN) side = "bottom";
	else if (side === "bottom" && r.bottom + gap + h > window.innerHeight - MARGIN) side = "top";
	else if (side === "left" && r.left - gap - w < MARGIN) side = "right";
	else if (side === "right" && r.right + gap + w > window.innerWidth - MARGIN) side = "left";
	if (side !== placement) {
		el.removeClass(`mod-${placement}`);
		if (side !== "bottom") el.addClass(`mod-${side}`);
	}
	let left: number;
	let top: number;
	if (side === "top" || side === "bottom") {
		left = r.left + r.width / 2 - w / 2;
		top = side === "top" ? r.top - gap - h : r.bottom + gap;
	} else {
		top = r.top + r.height / 2 - h / 2;
		left = side === "left" ? r.left - gap - w : r.right + gap;
	}
	el.style.left = `${Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN))}px`;
	el.style.top = `${Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))}px`;
}
