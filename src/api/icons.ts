import { createElement, icons } from "lucide";

export { setTooltip, type TooltipOptions } from "./ui/tooltip";

// Obsidian icon ids are Lucide names in kebab case, optionally prefixed
// "lucide-"; plugins may add their own 100x100 SVG bodies with addIcon.
const custom = new Map<string, string>();

// Ids from Obsidian's icon set before Lucide, which plugins still use. The
// Lucide icon each one maps to is the one a running Obsidian renders for it.
const LEGACY: Record<string, string> = {
	"audio-file": "file-audio",
	blocks: "layout-list",
	"bullet-list": "list",
	"calendar-with-checkmark": "calendar-check",
	checkmark: "check",
	cross: "x",
	"crossed-star": "star-off",
	document: "file",
	documents: "files",
	"dot-network": "git-fork",
	"double-down-arrow-glyph": "chevrons-down",
	"double-up-arrow-glyph": "chevrons-up",
	"down-arrow-with-tail": "arrow-down",
	enter: "log-in",
	folder: "folder-open",
	"forward-arrow": "forward",
	gear: "settings",
	"go-to-file": "file-input",
	"horizontal-split": "separator-horizontal",
	"image-file": "image",
	install: "download-cloud",
	"lines-of-text": "align-left",
	"minus-with-circle": "minus-circle",
	"pane-layout": "layout",
	"paper-plane": "send",
	"pdf-file": "file-text",
	pencil: "edit-3",
	"plus-with-circle": "plus-circle",
	"popup-open": "arrow-up-right",
	presentation: "monitor",
	"price-tag-glyph": "tag",
	reset: "rotate-ccw",
	"stacked-levels": "folder-tree",
	switch: "repeat",
	sync: "refresh-cw",
	"three-horizontal-bars": "menu",
	trash: "trash-2",
	"up-arrow-with-tail": "arrow-up",
	"vertical-split": "separator-vertical",
	"vertical-three-dots": "more-vertical",
	"wrench-screwdriver-glyph": "wrench",
};

// Obsidian draws these with its own SVGs; the nearest Lucide icon stands in,
// keeping the Obsidian id as the class so plugin CSS still matches.
const OWN: Record<string, string> = {
	"box-glyph": "copy-plus",
	"bracket-glyph": "brackets",
	"broken-link": "unlink",
	"check-small": "check",
	dice: "dice-3",
	"dice-glyph": "dice-3",
	experiment: "flask-conical",
	"heading-glyph": "heading",
	help: "circle-help",
	"left-arrow": "chevron-left",
	"link-glyph": "link",
	"links-coming-in": "corner-down-left",
	"links-going-out": "corner-up-right",
	"open-vault": "vault",
	paused: "circle-pause",
	"question-mark-glyph": "circle-help",
	"right-arrow": "chevron-right",
	"right-triangle": "chevron-down",
	"sheets-in-box": "copy-plus",
	"sidebar-left": "panel-left",
	"sidebar-right": "panel-right",
	"star-list": "star",
	"sync-small": "refresh-cw",
	tabs: "copy",
	"uppercase-lowercase-a": "case-sensitive",
};

let byLowerName: Map<string, string> | null = null;

// Lucide keys are PascalCase ("ArrowDown01"); ids may come in any kebab
// spelling of them ("arrow-down-0-1", or Obsidian's own "arrow-down-01").
function lucideNode(name: string) {
	byLowerName ??= new Map(Object.keys(icons).map((k) => [k.toLowerCase(), k]));
	const key = byLowerName.get(name.replace(/-/g, "").toLowerCase());
	return key ? (icons as Record<string, any>)[key] : undefined;
}

function lucideSvg(name: string, cls: string) {
	const node = lucideNode(name);
	if (!node) return null;
	const svg = createElement(node) as unknown as SVGSVGElement;
	svg.classList.add("svg-icon", cls);
	return svg;
}

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
	// Own keys only: ids such as "constructor" come from icon pickers too.
	if (Object.hasOwn(LEGACY, iconId)) return lucideSvg(LEGACY[iconId], `lucide-${LEGACY[iconId]}`);
	if (Object.hasOwn(OWN, iconId)) return lucideSvg(OWN[iconId], iconId);
	const name = iconId.replace(/^lucide-/, "");
	return lucideSvg(name, `lucide-${name}`);
}

// Obsidian empties the element even when the id is unknown.
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

// The ids as Obsidian lists them: every Lucide key, aliases included, in its
// kebab spelling, then the ids added with addIcon.
export function getIconIds() {
	const lucide = Object.keys(icons).map((key) => `lucide-${key.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase()}`);
	return [...lucide, ...custom.keys()];
}
