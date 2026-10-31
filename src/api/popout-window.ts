import { POPOUT_FRAME } from "../main/popout";

export interface PopoutBounds {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

// The window.open features of a popout at these bounds, rounded to whole
// pixels; a missing value leaves the choice to the system.
export function popoutFeatures(bounds: PopoutBounds) {
	const features = ["popup"];
	const add = (name: string, value: number | undefined) => {
		if (typeof value === "number" && Number.isFinite(value)) features.push(`${name}=${Math.round(value)}`);
	};
	add("width", bounds.width);
	add("height", bounds.height);
	add("left", bounds.x);
	add("top", bounds.y);
	return features.join(",");
}

// A popout window is a child window of this page, at about:blank, in this
// renderer: the page's own code builds and drives its document, as in
// Obsidian. Main allows exactly this window.open (main/popout.ts).
export function openPopoutWindow(id: string, bounds: PopoutBounds): Window {
	const win = window.open("about:blank", `${POPOUT_FRAME}-${id}`, popoutFeatures(bounds));
	if (!win) throw new Error("Could not open a window");
	return win;
}

const isSheet = (node: Node): node is HTMLStyleElement | HTMLLinkElement =>
	node.nodeName === "STYLE" || (node.nodeName === "LINK" && (node as HTMLLinkElement).rel === "stylesheet");

// A popout shows the vault window's styles: the app stylesheet, plugin, theme
// and snippet styles, CodeMirror's and MathJax's, in the same order, and the
// classes and inline styles of <html> and <body> (the theme, the accent
// colour). They follow every change there. Rules added through the CSSOM
// (MathJax adds its font rules with insertRule) change no text, so the rule
// counts are compared every second as well. Returns the function that stops
// mirroring.
export function mirrorDocument(target: Document): () => void {
	const source = document;
	const clones = new Map<Node, HTMLStyleElement | HTMLLinkElement>();
	// Styles whose clone was copied from the CSSOM, not the text.
	const fromRules = new WeakSet<Node>();
	const copyRules = (from: HTMLStyleElement, to: HTMLStyleElement) => {
		const rules = from.sheet ? Array.from(from.sheet.cssRules, (r) => r.cssText) : null;
		to.textContent = rules ? rules.join("\n") : from.textContent;
		fromRules.add(from);
	};
	const syncHead = (changed: Set<Node> | null) => {
		const sheets = Array.from(source.head.childNodes).filter(isSheet);
		for (const [node, clone] of clones) {
			if (sheets.includes(node as HTMLStyleElement)) continue;
			clone.remove();
			clones.delete(node);
		}
		const firstClone = Array.from(target.head.childNodes).find((n) => [...clones.values()].includes(n as HTMLStyleElement));
		let previous: Node | null = null;
		for (const node of sheets) {
			let clone = clones.get(node);
			if (!clone) {
				clone = node.cloneNode(true) as HTMLStyleElement | HTMLLinkElement;
				if (clone.nodeName === "LINK") (clone as HTMLLinkElement).href = (node as HTMLLinkElement).href;
				clones.set(node, clone);
			} else if (node.nodeName === "STYLE" && (changed === null || changed.has(node))) {
				if (fromRules.has(node)) copyRules(node as HTMLStyleElement, clone as HTMLStyleElement);
				else if (clone.textContent !== node.textContent) clone.textContent = node.textContent;
			}
			// In the source's order, after the popout's own styles (CodeMirror
			// mounts its base theme first in the popout's head). Only a clone out
			// of place moves: a moved <link> loads its sheet again.
			if (previous === null) {
				if (clone.parentNode !== target.head) target.head.insertBefore(clone, firstClone ?? null);
			} else if (previous.nextSibling !== clone) target.head.insertBefore(clone, previous.nextSibling);
			previous = clone;
		}
	};
	const syncRules = () => {
		for (const [node, clone] of clones) {
			if (node.nodeName !== "STYLE") continue;
			const from = (node as HTMLStyleElement).sheet;
			const to = (clone as HTMLStyleElement).sheet;
			if (from && to && from.cssRules.length !== to.cssRules.length) copyRules(node as HTMLStyleElement, clone as HTMLStyleElement);
		}
	};
	const syncRoot = () => {
		for (const [from, to] of [
			[source.documentElement, target.documentElement],
			[source.body, target.body],
		]) {
			to.className = from.className;
			to.setAttribute("style", from.getAttribute("style") ?? "");
		}
		target.body.addClass("is-popout-window");
	};
	syncHead(null);
	syncRoot();
	const headObserver = new MutationObserver((records) => {
		const changed = new Set<Node>();
		for (const r of records) {
			let node: Node | null = r.target;
			while (node && node.parentNode !== source.head) node = node.parentNode;
			if (node) changed.add(node);
		}
		syncHead(changed);
	});
	headObserver.observe(source.head, { childList: true, subtree: true, characterData: true, attributes: true });
	const rootObserver = new MutationObserver(syncRoot);
	for (const el of [source.documentElement, source.body]) rootObserver.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
	const timer = window.setInterval(syncRules, 1000);
	return () => {
		headObserver.disconnect();
		rootObserver.disconnect();
		window.clearInterval(timer);
	};
}
