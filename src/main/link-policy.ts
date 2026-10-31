// Schemes a link never hands to the system: file: (a note must not launch a
// local program) and schemes that run code or show the browser's or the app's
// own pages. justnotes registers no scheme of its own (protocol.ts); its page
// is file:. Main applies this to every link; the renderer refuses to bookmark
// a URL main would drop.
export const droppedSchemes = new Set(["file:", "javascript:", "data:", "blob:", "about:", "chrome:", "chrome-extension:", "devtools:", "view-source:"]);

// Whether a navigation of a vault window stays on its page: the same URL,
// ?vault= included, up to the fragment. Another query is another vault's
// page (a link to index.html?vault=<folder> would load that folder's
// plugins in this window), so it goes through the link policy instead.
export function sameAppPage(target: string, current: string) {
	try {
		const a = new URL(target);
		const b = new URL(current);
		a.hash = "";
		b.hash = "";
		return a.href === b.href;
	} catch {
		return false;
	}
}
