import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";

// Obsidian sanitizes rendered HTML with DOMPurify: scripts, event handler
// attributes and script URLs go; iframes, <style>, classes and data-*
// attributes stay. This renderer runs with Node integration and without web
// security, so whatever runs here can require("child_process"), and so can any
// iframe that keeps its own origin; iframes are therefore always sandboxed
// without allow-same-origin.
const SANDBOX = "allow-scripts allow-popups allow-forms allow-presentation";

const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
	ADD_TAGS: ["iframe"],
	ADD_ATTR: ["target", "contenteditable", "allow", "allowfullscreen", "frameborder", "scrolling", "referrerpolicy", "loading"],
	// Any scheme (obsidian:, file:, zotero:, ...) except the ones that run code;
	// DOMPurify still allows data: images on media elements.
	ALLOWED_URI_REGEXP: /^(?!(?:javascript|vbscript|data):)/i,
	// Keeps a leading <style> in the body instead of dropping it.
	FORCE_BODY: true,
	RETURN_DOM_FRAGMENT: true,
};

let purify: Purifier | null = null;

function instance() {
	if (!purify) {
		purify = DOMPurify(window);
		purify.addHook("afterSanitizeAttributes", (node) => {
			if (node.tagName === "IFRAME") node.setAttribute("sandbox", SANDBOX);
		});
	}
	return purify;
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
	// DOMPurify builds the fragment in an inert document; adopt it so it belongs
	// to the page like any other node a plugin creates.
	return document.adoptNode(instance().sanitize(html, CONFIG));
}
