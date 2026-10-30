import { createElement, icons } from "lucide";

// Obsidian icon ids are Lucide names in kebab case, optionally prefixed
// "lucide-"; plugins may add their own 100x100 SVG bodies with addIcon.
const custom = new Map<string, string>();

const pascal = (id: string) =>
	id
		.replace(/^lucide-/, "")
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join("");

export function getIcon(iconId: string): SVGSVGElement | null {
	const body = custom.get(iconId);
	if (body !== undefined) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 100 100");
		svg.setAttribute("width", "24");
		svg.setAttribute("height", "24");
		svg.innerHTML = body;
		svg.classList.add("svg-icon", iconId);
		return svg;
	}
	const node = (icons as Record<string, any>)[pascal(iconId)];
	if (!node) return null;
	const svg = createElement(node) as unknown as SVGSVGElement;
	svg.classList.add("svg-icon", iconId.startsWith("lucide-") ? iconId : `lucide-${iconId}`);
	return svg;
}

export function setIcon(parent: HTMLElement, iconId: string) {
	parent.empty();
	const svg = getIcon(iconId);
	if (svg) parent.appendChild(svg);
}

export function addIcon(iconId: string, svgContent: string) {
	custom.set(iconId, svgContent);
}

export function removeIcon(iconId: string) {
	custom.delete(iconId);
}

export function getIconIds() {
	const ids = Object.keys(icons).map((n) => `lucide-${n.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`);
	return [...ids, ...custom.keys()];
}

export interface TooltipOptions {
	placement?: "bottom" | "right" | "left" | "top";
	delay?: number;
}

export function setTooltip(el: HTMLElement, tooltip: string, options?: TooltipOptions) {
	el.setAttribute("aria-label", tooltip);
	if (options?.placement) el.setAttribute("data-tooltip-position", options.placement);
	el.title = tooltip;
}
