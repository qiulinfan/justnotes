import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { Tag, tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { renderMath } from "./markdown";

// Math in Markdown: `$…$` and `$$…$$` inline, and `$$` blocks.
export const mathTag = Tag.define(tags.string);
const DOLLAR = 36;
const BACKSLASH = 92;

export const mathSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "InlineMath", style: mathTag },
		{ name: "BlockMath", block: true, style: mathTag },
	],
	parseInline: [
		{
			name: "InlineMath",
			before: "Escape",
			parse(cx, next, pos) {
				if (next !== DOLLAR) return -1;
				const fence = cx.char(pos + 1) === DOLLAR ? 2 : 1;
				for (let i = pos + fence; i < cx.end; i++) {
					const c = cx.char(i);
					if (c === BACKSLASH) {
						i++;
						continue;
					}
					if (c !== DOLLAR) continue;
					if (fence === 2 && cx.char(i + 1) !== DOLLAR) continue;
					if (i === pos + fence) return -1;
					return cx.addElement(cx.elt("InlineMath", pos, i + fence));
				}
				return -1;
			},
		},
	],
	parseBlock: [
		{
			name: "BlockMath",
			before: "FencedCode",
			parse(cx, line) {
				if (!line.text.slice(line.pos).startsWith("$$")) return false;
				const start = cx.lineStart + line.pos;
				const rest = line.text.slice(line.pos + 2).trimEnd();
				let end = cx.lineStart + line.text.length;
				// `$$ x $$` on one line is a complete block.
				if (!(rest.length >= 2 && rest.endsWith("$$"))) {
					while (cx.nextLine()) {
						end = cx.lineStart + line.text.length;
						if (line.text.trimEnd().endsWith("$$")) break;
					}
				}
				cx.nextLine();
				cx.addElement(cx.elt("BlockMath", start, end));
				return true;
			},
		},
	],
};

class MathWidget extends WidgetType {
	constructor(
		readonly tex: string,
		readonly display: boolean,
	) {
		super();
	}

	eq(other: MathWidget) {
		return other.tex === this.tex && other.display === this.display;
	}

	toDOM() {
		const el = createEl(this.display ? "div" : "span", { cls: ["math", this.display ? "math-block" : "math-inline", "cm-embed-block"] });
		el.appendChild(renderMath(this.tex, this.display));
		return el;
	}

	ignoreEvent() {
		return false;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(
		readonly checked: boolean,
		readonly pos: number,
	) {
		super();
	}

	eq(other: CheckboxWidget) {
		return other.checked === this.checked && other.pos === this.pos;
	}

	toDOM(view: EditorView) {
		const box = createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
		box.checked = this.checked;
		box.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
		});
		return box;
	}

	ignoreEvent() {
		return true;
	}
}

class BulletWidget extends WidgetType {
	eq() {
		return true;
	}

	toDOM() {
		return createSpan({ cls: "list-bullet", text: "•" });
	}
}

class RuleWidget extends WidgetType {
	eq() {
		return true;
	}

	toDOM() {
		return createEl("hr", "cm-hr");
	}
}

class ImageWidget extends WidgetType {
	constructor(readonly src: string) {
		super();
	}

	eq(other: ImageWidget) {
		return other.src === this.src;
	}

	toDOM() {
		return createEl("img", { cls: "cm-image-embed", attr: { src: this.src } });
	}
}

const hide = Decoration.replace({});
const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
const SKIP_WIKILINKS = new Set(["InlineCode", "FencedCode", "CodeBlock", "InlineMath", "BlockMath", "CodeText"]);

export interface LivePreviewHost {
	resolveImage(linkpath: string): string | null;
}

// Syntax stays visible wherever the selection touches; elsewhere it is hidden
// or rendered, as in Obsidian's Live Preview.
function build(state: EditorState, host: LivePreviewHost): DecorationSet {
	const decos: Range<Decoration>[] = [];
	const ranges = state.selection.ranges;
	const touches = (from: number, to: number) => ranges.some((r) => r.from <= to && r.to >= from);
	const touchesLines = (from: number, to: number) => touches(state.doc.lineAt(from).from, state.doc.lineAt(to).to);
	const lineClass = (pos: number, cls: string) => decos.push(Decoration.line({ class: cls }).range(state.doc.lineAt(pos).from));

	syntaxTree(state).iterate({
		enter: (node) => {
			const { from, to, name } = node;
			const heading = /^ATXHeading(\d)$/.exec(name);
			if (heading) {
				lineClass(from, `HyperMD-header HyperMD-header-${heading[1]}`);
				return;
			}
			switch (name) {
				case "HeaderMark": {
					if (node.node.parent?.name.startsWith("SetextHeading") || touchesLines(from, to)) return;
					const end = state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
					decos.push(hide.range(from, end));
					return;
				}
				case "EmphasisMark":
				case "StrikethroughMark": {
					const parent = node.node.parent!;
					if (!touches(parent.from, parent.to)) decos.push(hide.range(from, to));
					return;
				}
				case "CodeMark": {
					const parent = node.node.parent!;
					if (parent.name === "InlineCode" && !touches(parent.from, parent.to)) decos.push(hide.range(from, to));
					return;
				}
				case "FencedCode": {
					for (let pos = from; pos <= to; ) {
						const line = state.doc.lineAt(pos);
						lineClass(line.from, "HyperMD-codeblock");
						pos = line.to + 1;
					}
					return false;
				}
				case "Blockquote": {
					for (let pos = from; pos <= to; ) {
						const line = state.doc.lineAt(pos);
						lineClass(line.from, "HyperMD-quote");
						pos = line.to + 1;
					}
					return;
				}
				case "QuoteMark": {
					if (touchesLines(from, to)) return;
					const end = state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
					decos.push(hide.range(from, end));
					return;
				}
				case "ListMark": {
					const list = node.node.parent?.parent;
					if (list?.name !== "BulletList" || touchesLines(from, to)) return;
					if (node.node.nextSibling?.name === "Task") return;
					decos.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
					return;
				}
				case "TaskMarker": {
					if (touchesLines(from, to)) return;
					const checked = state.sliceDoc(from + 1, from + 2).toLowerCase() === "x";
					const mark = node.node.parent?.parent?.firstChild;
					const start = mark?.name === "ListMark" ? mark.from : from;
					decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, from) }).range(start, to));
					return;
				}
				case "HorizontalRule": {
					if (!touchesLines(from, to)) decos.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
					return;
				}
				case "Link": {
					if (touches(from, to)) return;
					const url = node.node.getChild("URL");
					const marks = node.node.getChildren("LinkMark");
					if (!url || marks.length < 2) return;
					const textEnd = marks[1].from;
					const href = state.sliceDoc(url.from, url.to);
					decos.push(hide.range(from, marks[0].to));
					decos.push(Decoration.mark({ class: "cm-link-rendered", attributes: { "data-href": href } }).range(marks[0].to, textEnd));
					decos.push(hide.range(textEnd, to));
					return false;
				}
				case "Image": {
					if (touches(from, to)) return;
					const url = node.node.getChild("URL");
					const src = url ? host.resolveImage(decodeURI(state.sliceDoc(url.from, url.to))) : null;
					if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src) }).range(from, to));
					return false;
				}
				case "InlineMath": {
					if (touches(from, to)) return false;
					const text = state.sliceDoc(from, to);
					const fence = text.startsWith("$$") ? 2 : 1;
					decos.push(Decoration.replace({ widget: new MathWidget(text.slice(fence, -fence), fence === 2) }).range(from, to));
					return false;
				}
				case "BlockMath": {
					if (touchesLines(from, to)) return false;
					const text = state.sliceDoc(from, to).trim();
					const tex = text.slice(2, text.endsWith("$$") && text.length >= 4 ? -2 : undefined);
					decos.push(Decoration.replace({ widget: new MathWidget(tex.trim(), true), block: true }).range(from, to));
					return false;
				}
			}
		},
	});

	// Wikilinks and embeds are not CommonMark, so find them in the text.
	const tree = syntaxTree(state);
	const text = state.doc.toString();
	for (const m of text.matchAll(/(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g)) {
		const from = m.index!;
		const to = from + m[0].length;
		let skip = false;
		for (let n: any = tree.resolveInner(from, 1); n; n = n.parent) {
			if (SKIP_WIKILINKS.has(n.name)) skip = true;
		}
		if (skip || touches(from, to)) continue;
		const target = m[2].trim();
		if (m[1]) {
			const src = IMAGE.test(target) ? host.resolveImage(target) : null;
			if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src) }).range(from, to));
			continue;
		}
		const shownFrom = m[3] !== undefined ? to - 2 - m[3].length : from + 2;
		decos.push(hide.range(from, shownFrom));
		decos.push(Decoration.mark({ class: "cm-hmd-internal-link", attributes: { "data-href": target } }).range(shownFrom, to - 2));
		decos.push(hide.range(to - 2, to));
	}

	return Decoration.set(decos, true);
}

export function livePreview(host: LivePreviewHost): Extension {
	const field = StateField.define<DecorationSet>({
		create: (state) => build(state, host),
		update(decos, tr) {
			if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, host);
			return decos;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	return field;
}
