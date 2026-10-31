// Markdown link destinations: spaces and '#' in a path must be encoded; a
// block subpath keeps its '^' readable. Letters beyond ASCII stay as written
// (附件/图 1.png gives 附件/图%201.png), as in Obsidian's links and the
// owner's notes.
const encodeAscii = (text: string) => text.replace(/[\0-\x7f]+/g, (run) => encodeURI(run));
export const encodePath = (path: string) => encodeAscii(path).replace(/#/g, "%23");
export const encodeSubpath = (subpath: string) => encodeAscii(subpath).replace(/%5E/g, "^");
