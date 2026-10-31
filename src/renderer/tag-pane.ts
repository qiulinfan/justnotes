import { setIcon } from "../api/icons";
import { searchTag } from "../api/live-preview";
import { getAllTags } from "../api/metadata-utils";
import { Menu } from "../api/ui/menu";
import { debounce } from "../api/util";
import { ItemView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

export type TagSortOrder = "alphabetical" | "alphabeticalReverse" | "frequency" | "frequencyReverse";

export interface TagNode {
	// What the row shows: the last part of a nested tag in the tree, the whole
	// tag in the flat list.
	name: string;
	// The tag with '#', as first spelled.
	tag: string;
	// Notes that carry the tag or, in the tree, a tag nested under it.
	count: number;
	children: TagNode[];
}

// The tags of the vault's notes, each counted once per note; spellings that
// differ only in case are one tag, under the first one seen. With `nested`,
// #a/b is a child of #a, which exists even when no note uses it alone.
export function tagTree(notes: string[][], nested: boolean): TagNode[] {
	const roots: TagNode[] = [];
	const nodes = new Map<string, TagNode & { notes: Set<number> }>();
	const node = (key: string, tag: string, name: string, parent: TagNode[]) => {
		let found = nodes.get(key);
		if (!found) {
			found = { name, tag, count: 0, children: [], notes: new Set() };
			nodes.set(key, found);
			parent.push(found);
		}
		return found;
	};
	notes.forEach((tags, note) => {
		for (const raw of tags) {
			const tag = raw.startsWith("#") ? raw : `#${raw}`;
			if (!nested) {
				node(tag.toLowerCase(), tag, tag, roots).notes.add(note);
				continue;
			}
			const parts = tag.slice(1).split("/").filter(Boolean);
			let siblings = roots;
			for (let i = 0; i < parts.length; i++) {
				const path = `#${parts.slice(0, i + 1).join("/")}`;
				const found = node(path.toLowerCase(), path, parts[i], siblings);
				found.notes.add(note);
				siblings = found.children;
			}
		}
	});
	for (const found of nodes.values()) found.count = found.notes.size;
	return roots;
}

// Sorts every level of the tree in place: by name (numbers in order, case
// ignored) or by count, ties by name.
export function sortTags(nodes: TagNode[], order: TagSortOrder): TagNode[] {
	const byName = (a: TagNode, b: TagNode) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	const compare: Record<TagSortOrder, (a: TagNode, b: TagNode) => number> = {
		alphabetical: byName,
		alphabeticalReverse: (a, b) => byName(b, a),
		frequency: (a, b) => b.count - a.count || byName(a, b),
		frequencyReverse: (a, b) => a.count - b.count || byName(a, b),
	};
	nodes.sort(compare[order]);
	for (const node of nodes) sortTags(node.children, order);
	return nodes;
}

const SORT_NAMES: [TagSortOrder, string][] = [
	["alphabetical", "Tag name (A to Z)"],
	["alphabeticalReverse", "Tag name (Z to A)"],
	["frequency", "Frequency (high to low)"],
	["frequencyReverse", "Frequency (low to high)"],
];

// Obsidian's Tags view: every tag with the number of notes carrying it,
// nested tags as a tree. A click searches for the tag, as a rendered tag does.
export class TagView extends ItemView {
	#sortOrder: TagSortOrder = "frequency";
	#nested = true;
	// Tags (lowercased) whose nested tags show.
	#expanded = new Set<string>();
	#treeEl!: HTMLElement;
	#nestedButton!: HTMLElement;
	#expandButton!: HTMLElement;
	#roots: TagNode[] = [];
	#refresh = debounce(() => this.#render(), 500, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "tags";
		this.navigation = false;
	}

	getViewType() {
		return "tag";
	}

	getDisplayText() {
		return "Tags";
	}

	getState() {
		return { sortOrder: this.#sortOrder, useHierarchy: this.#nested };
	}

	async setState(state: any) {
		if (SORT_NAMES.some(([order]) => order === state?.sortOrder)) this.#sortOrder = state.sortOrder;
		if (typeof state?.useHierarchy === "boolean") this.#nested = state.useHierarchy;
		if (this.#treeEl) this.#render();
	}

	async onOpen() {
		this.headerEl.hide();
		this.contentEl.addClass("tag-pane");
		const buttons = this.contentEl.createDiv("nav-header").createDiv("nav-buttons-container");
		const button = (icon: string, title: string, cb: (evt: MouseEvent) => void) => {
			const el = buttons.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": title } });
			setIcon(el, icon);
			el.addEventListener("click", cb);
			return el;
		};
		this.#nestedButton = button("list-tree", "Show nested tags", () => {
			this.#nested = !this.#nested;
			this.#changed();
		});
		button("arrow-up-narrow-wide", "Change sort order", (evt) => {
			const menu = new Menu();
			for (const [order, title] of SORT_NAMES) {
				menu.addItem((item) =>
					item
						.setTitle(title)
						.setChecked(order === this.#sortOrder)
						.onClick(() => {
							this.#sortOrder = order;
							this.#changed();
						}),
				);
			}
			menu.showAtMouseEvent(evt);
		});
		this.#expandButton = button("chevrons-up-down", "Expand all", () => {
			if (this.#expanded.size) this.#expanded.clear();
			else {
				const all = (nodes: TagNode[]) => {
					for (const n of nodes) {
						if (n.children.length) this.#expanded.add(n.tag.toLowerCase());
						all(n.children);
					}
				};
				all(this.#roots);
			}
			this.#render();
		});
		this.#treeEl = this.contentEl.createDiv("tag-container");
		this.registerEvent(this.app.metadataCache.on("changed", () => this.#refresh()));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.#refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.#refresh()));
		this.#render();
	}

	#changed() {
		this.#render();
		this.app.workspace.requestSaveLayout();
	}

	#render() {
		const notes = this.app.vault.getMarkdownFiles().map((file) => getAllTags(this.app.metadataCache.getFileCache(file)) ?? []);
		this.#roots = sortTags(tagTree(notes, this.#nested), this.#sortOrder);
		this.#nestedButton.toggleClass("is-active", this.#nested);
		const anyExpanded = this.#expanded.size > 0;
		setIcon(this.#expandButton, anyExpanded ? "chevrons-down-up" : "chevrons-up-down");
		this.#expandButton.setAttr("aria-label", anyExpanded ? "Collapse all" : "Expand all");
		this.#expandButton.toggle(this.#nested);
		const scroll = this.#treeEl.scrollTop;
		this.#treeEl.empty();
		if (!this.#roots.length) this.#treeEl.createDiv({ cls: "pane-empty", text: "No tags found." });
		this.#add(this.#treeEl, this.#roots);
		this.#treeEl.scrollTop = scroll;
	}

	#add(parent: HTMLElement, nodes: TagNode[]) {
		for (const node of nodes) {
			const key = node.tag.toLowerCase();
			const item = parent.createDiv("tree-item tag-pane-tag-item");
			const self = item.createDiv("tree-item-self tag-pane-tag is-clickable");
			const icon = self.createDiv("tree-item-icon collapse-icon");
			self.createDiv({ cls: "tree-item-inner tag-pane-tag-text", text: node.name });
			self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair tag-pane-tag-count", text: String(node.count) });
			self.addEventListener("click", () => searchTag(this.app, node.tag));
			if (!node.children.length) continue;
			const open = this.#expanded.has(key);
			setIcon(icon, open ? "chevron-down" : "chevron-right");
			icon.addEventListener("click", (evt) => {
				evt.stopPropagation();
				if (!this.#expanded.delete(key)) this.#expanded.add(key);
				this.#render();
			});
			if (open) this.#add(item.createDiv("tree-item-children"), node.children);
		}
	}
}
