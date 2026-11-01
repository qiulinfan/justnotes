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

// The config is set once: passed to every sanitize call, DOMPurify parses and
// clones it each time, which cost more than the sanitizing itself when the
// reading view renders a long note section by section.
function instance() {
	if (!purify) {
		purify = DOMPurify(window);
		purify.setConfig(CONFIG);
		purify.addHook("afterSanitizeAttributes", (node) => {
			if (node.tagName === "IFRAME") node.setAttribute("sandbox", SANDBOX);
		});
	}
	return purify;
}

// justnotes: sanitizeHTMLToDom with a hook that may edit the fragment while
// it is still inert, before images in it start loading.
export function sanitizeHTML(html: string, prepare?: (fragment: DocumentFragment) => void): DocumentFragment {
	const fragment = instance().sanitize(html) as unknown as DocumentFragment;
	prepare?.(fragment);
	// Adopted, the fragment belongs to the page like any node a plugin creates.
	return document.adoptNode(fragment);
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
	return sanitizeHTML(html);
}
