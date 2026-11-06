// A chapter's text as one string, the way a reader sees it: whitespace runs
// as one space and a space between blocks, so "Title" and the paragraph
// after it do not run together. Each character maps back to its text node,
// so the n-th match found in the book's copy of a chapter is the n-th in
// the frame's, and becomes a Range there.
const BLOCKS = new Set([
	"address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
	"header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
]);
const SKIP = new Set(["script", "style", "head", "title"]);

export interface TextIndex {
	text: string;
	// For each character of `text`, its node and offset (null for a space
	// that stands for a block boundary).
	nodes: (Text | null)[];
	offsets: number[];
}

export function textIndex(root: Node): TextIndex {
	const out: string[] = [];
	const nodes: (Text | null)[] = [];
	const offsets: number[] = [];
	let space = true;
	const push = (ch: string, node: Text | null, offset: number) => {
		const ws = /\s/.test(ch);
		if (ws && space) return;
		out.push(ws ? " " : ch);
		nodes.push(node);
		offsets.push(offset);
		space = ws;
	};
	const walk = (node: Node) => {
		if (node.nodeType === 3) {
			const text = (node as Text).data;
			for (let i = 0; i < text.length; i++) push(text[i], node as Text, i);
			return;
		}
		if (node.nodeType !== 1) return;
		const name = (node as Element).localName;
		if (SKIP.has(name)) return;
		const block = BLOCKS.has(name);
		if (block) push(" ", null, 0);
		for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
		if (block) push(" ", null, 0);
	};
	walk(root);
	while (out.length && out[out.length - 1] === " ") {
		out.pop();
		nodes.pop();
		offsets.pop();
	}
	return { text: out.join(""), nodes, offsets };
}

// Where the occurrences of `needle` are in `text`, as start offsets.
export function occurrences(text: string, needle: string, caseSensitive: boolean) {
	const hay = caseSensitive ? text : text.toLowerCase();
	const want = caseSensitive ? needle : needle.toLowerCase();
	const found: number[] = [];
	if (!want) return found;
	for (let at = hay.indexOf(want); at >= 0; at = hay.indexOf(want, at + want.length)) found.push(at);
	return found;
}

// The Range of `length` characters at `start` in an index, or null when it
// begins or ends on a block boundary only.
export function rangeAt(index: TextIndex, start: number, length: number, doc: Document) {
	let from = start;
	let to = start + length - 1;
	while (from <= to && !index.nodes[from]) from++;
	while (to >= from && !index.nodes[to]) to--;
	if (from > to) return null;
	const range = doc.createRange();
	range.setStart(index.nodes[from]!, index.offsets[from]);
	range.setEnd(index.nodes[to]!, index.offsets[to] + 1);
	return range;
}
