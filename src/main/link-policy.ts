// Schemes a link never hands to the system: file: (a note must not launch a
// local program) and schemes that run code or show the browser's or the app's
// own pages. justnotes registers no scheme of its own (protocol.ts); its page
// is file:. Main applies this to every link; the renderer refuses to bookmark
// a URL main would drop.
export const droppedSchemes = new Set(["file:", "javascript:", "data:", "blob:", "about:", "chrome:", "chrome-extension:", "devtools:", "view-source:"]);
