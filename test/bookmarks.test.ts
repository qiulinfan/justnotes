import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { BookmarksInstance } from "../src/renderer/bookmarks";
import {
	type BookmarksData,
	bookmarkUrl,
	cloneBookmarks,
	droppedUrls,
	mergeBookmarks,
	moveBookmark,
	newBookmark,
	parseBookmarks,
	removeDeletedFromBookmarks,
	renameInBookmarks,
	serializeBookmarks,
	urlTitle,
} from "../src/renderer/bookmarks-data";

installLanguageExtensions();

// A bookmarks.json as Obsidian writes it, with a field and an item type
// justnotes does not know.
const OBSIDIAN = `{
  "items": [
    {
      "type": "file",
      "ctime": 1700000000001,
      "path": "Notes/A.md",
      "subpath": "#Intro",
      "title": "Intro"
    },
    {
      "type": "group",
      "ctime": 1700000000002,
      "items": [
        {
          "type": "folder",
          "ctime": 1700000000003,
          "path": "Notes"
        },
        {
          "type": "search",
          "ctime": 1700000000004,
          "query": "tag:#todo"
        }
      ],
      "title": "Work"
    },
    {
      "type": "future-type",
      "ctime": 1700000000005,
      "color": "red"
    }
  ],
  "version": 2
}`;

const data = (text = OBSIDIAN) => parseBookmarks(text)!;
const titles = (d: BookmarksData) => JSON.stringify(d.items, (key, value) => (key === "" || Array.isArray(value) || typeof value !== "object" ? value : value.title ?? value.path ?? value.query ?? value.type));

// Obsidian and the owner's git read the file justnotes writes: an unchanged
// file must serialize to the same bytes, and new items take Obsidian's key
// order, or every save would show up as a diff.
describe("bookmarks.json format", () => {
	test("a file read and written again is byte for byte the same, unknown fields and types included", () => {
		expect(serializeBookmarks(data())).toBe(OBSIDIAN);
	});

	test("new items list their fields in Obsidian's order", () => {
		const item = newBookmark("file", 5, { title: "T", subpath: "#^abc", path: "a.md" });
		expect(Object.keys(item)).toEqual(["type", "ctime", "path", "subpath", "title"]);
		expect(Object.keys(newBookmark("group", 6, { title: "G" }))).toEqual(["type", "ctime", "items", "title"]);
	});

	test("text that is not a bookmarks file is refused rather than read as empty", () => {
		expect(parseBookmarks('{"items": [')).toBeNull();
		expect(parseBookmarks('{"items": {}}')).toBeNull();
		expect(parseBookmarks("{}")?.items).toEqual([]);
	});
});

// What the Bookmark a URL dialog, URL drops, the link menu and the CLI save:
// a bookmark that opens, since main hands its URL to the system.
describe("URL bookmarks", () => {
	test("a URL typed without a scheme gets https; text that is no openable URL is refused", () => {
		expect(bookmarkUrl(" example.com/docs?q=1 ")).toBe("https://example.com/docs?q=1");
		expect(bookmarkUrl("localhost:3000")).toBe("https://localhost:3000");
		expect(bookmarkUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
		expect(bookmarkUrl("zotero://select/items/1")).toBe("zotero://select/items/1");
		for (const bad of ["", "not a url", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "https://", "notes"]) expect(bookmarkUrl(bad)).toBeNull();
		// Dropped or linked text needs its scheme: a word with a dot is no link.
		expect(bookmarkUrl("node.js", false)).toBeNull();
	});

	test("the default title is the host and path, decoded", () => {
		expect(urlTitle("https://www.example.com/docs/page/")).toBe("www.example.com/docs/page");
		expect(urlTitle("https://example.com/")).toBe("example.com");
		expect(urlTitle("https://zh.wikipedia.org/wiki/%E7%AC%94%E8%AE%B0")).toBe("zh.wikipedia.org/wiki/笔记");
		expect(urlTitle("mailto:me@example.com")).toBe("me@example.com");
	});

	test("a drop bookmarks the uri-list's URLs, or plain text only when every line is a URL", () => {
		expect(droppedUrls("# comment\r\nhttps://a.example/\r\nhttps://b.example/\r\nhttps://a.example/", "ignored")).toEqual(["https://a.example/", "https://b.example/"]);
		expect(droppedUrls("", "https://a.example/\nhttps://b.example/")).toEqual(["https://a.example/", "https://b.example/"]);
		expect(droppedUrls("", "see https://a.example/")).toEqual([]);
		expect(droppedUrls("file:///Users/me/x.md", "")).toEqual([]);
	});
});

describe("following the vault", () => {
	test("a renamed folder moves the bookmarks of the folder and of the files in it", () => {
		const d = data();
		expect(renameInBookmarks(d.items, "Notes", "Archive/Notes")).toBe(true);
		expect(d.items[0].path).toBe("Archive/Notes/A.md");
		expect(d.items[1].items![0].path).toBe("Archive/Notes");
		expect(renameInBookmarks(d.items, "Note", "X")).toBe(false);
	});

	test("deleting a folder removes the bookmarks inside it, nested in groups too", () => {
		const d = data();
		expect(removeDeletedFromBookmarks(d.items, "Notes")).toBe(true);
		expect(titles(d)).toBe('["Work","future-type"]');
		expect(d.items[0].items!.map((i) => i.type)).toEqual(["search"]);
	});
});

describe("moving bookmarks", () => {
	test("an item dropped further down its own list lands before the item it was dropped on", () => {
		const d = data();
		const [file, group, other] = d.items;
		moveBookmark(d.items, file, null, 2);
		expect(d.items).toEqual([group, file, other]);
	});

	test("a group never moves into itself", () => {
		const d = data();
		const group = d.items[1];
		expect(moveBookmark(d.items, group, group, 0)).toBe(false);
		expect(d.items[1]).toBe(group);
	});
});

// The file changed on disk (Obsidian, git) while justnotes had changes of
// its own: both sides' changes survive.
describe("merging bookmarks.json", () => {
	test("with no changes of ours the result is the file exactly", () => {
		const base = data();
		const theirs = data();
		theirs.items[0].title = "Renamed in Obsidian";
		(theirs.items[0] as Record<string, unknown>).extra = 1;
		expect(serializeBookmarks(mergeBookmarks(base, cloneBookmarks(base), theirs))).toBe(serializeBookmarks(theirs));
	});

	test("an item we added and an item they added are both kept, each where it was put", () => {
		const base = data();
		const ours = cloneBookmarks(base);
		ours.items[1].items!.push(newBookmark("url", 9, { url: "https://example.com" }));
		const theirs = cloneBookmarks(base);
		theirs.items.unshift(newBookmark("file", 8, { path: "B.md" }));
		const merged = mergeBookmarks(base, ours, theirs);
		expect(merged.items.map((i) => i.path ?? i.type)).toEqual(["B.md", "Notes/A.md", "group", "future-type"]);
		expect(merged.items[2].items!.map((i) => i.type)).toEqual(["folder", "search", "url"]);
	});

	test("our removal and title change apply on top of their reorder and new field", () => {
		const base = data();
		const ours = cloneBookmarks(base);
		ours.items.splice(2, 1);
		ours.items[0].title = "Mine";
		const theirs = cloneBookmarks(base);
		theirs.items.reverse();
		(theirs.items[2] as Record<string, unknown>).pinned = true;
		const merged = mergeBookmarks(base, ours, theirs);
		expect(merged.items.map((i) => i.type)).toEqual(["group", "file"]);
		expect(merged.items[1]).toMatchObject({ title: "Mine", pinned: true, subpath: "#Intro" });
	});

	test("an item we moved into a group they renamed ends up in that group", () => {
		const base = data();
		const ours = cloneBookmarks(base);
		moveBookmark(ours.items, ours.items[0], ours.items[1], 0);
		const theirs = cloneBookmarks(base);
		theirs.items[1].title = "Projects";
		const merged = mergeBookmarks(base, ours, theirs);
		expect(merged.items.map((i) => i.title ?? i.type)).toEqual(["Projects", "future-type"]);
		expect(merged.items[0].items!.map((i) => i.type)).toEqual(["file", "folder", "search"]);
	});
});

// The instance against a fake vault folder: what reaches the disk.
function fakeVault(files: Record<string, string>) {
	const writes: string[] = [];
	const app = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				read: async (path: string) => {
					if (!(path in files)) throw new Error(`ENOENT: ${path}`);
					return files[path];
				},
				write: async (path: string, text: string) => {
					writes.push(text);
					files[path] = text;
				},
			},
			getAbstractFileByPath: () => null,
		},
	} as any;
	return { app, writes, files };
}

describe("the bookmarks instance and bookmarks.json", () => {
	test("loading and changes on disk never write; a change of ours writes once, in Obsidian's format", async () => {
		const { app, writes, files } = fakeVault({ ".obsidian/bookmarks.json": OBSIDIAN });
		const instance = new BookmarksInstance(app);
		let changed = 0;
		instance.on("changed", () => changed++);
		await instance.load();
		expect(instance.getBookmarks().map((i) => i.type)).toEqual(["file", "folder", "search", "future-type"]);
		files[".obsidian/bookmarks.json"] = OBSIDIAN.replace('"Intro"\n', '"From Obsidian"\n');
		await instance.saveData();
		expect(instance.items[0].title).toBe("From Obsidian");
		expect(writes).toEqual([]);
		instance.updateItem(instance.items[0], { title: "Mine" });
		await instance.saveData();
		expect(writes).toEqual([OBSIDIAN.replace('"Intro"\n', '"Mine"\n')]);
		expect(changed).toBeGreaterThan(0);
	});

	test("a save after the file changed on disk merges the file's change instead of overwriting it", async () => {
		const { app, files } = fakeVault({ ".obsidian/bookmarks.json": OBSIDIAN });
		const instance = new BookmarksInstance(app);
		await instance.load();
		// Obsidian adds a bookmark; justnotes has not seen the change yet.
		const theirs = data();
		theirs.items.push(newBookmark("file", 1700000000009, { path: "Obsidian.md" }));
		files[".obsidian/bookmarks.json"] = serializeBookmarks(theirs);
		instance.addItem(newBookmark("file", 0, { path: "Mine.md" }));
		await instance.saveData();
		const saved = parseBookmarks(files[".obsidian/bookmarks.json"])!;
		expect(saved.items.map((i) => i.path ?? i.type)).toEqual(["Notes/A.md", "group", "future-type", "Mine.md", "Obsidian.md"]);
		expect(saved.version).toBe(2);
	});

	test("without a bookmarks.json nothing is created until a bookmark is added", async () => {
		const { app, writes, files } = fakeVault({});
		const instance = new BookmarksInstance(app);
		await instance.load();
		expect(writes).toEqual([]);
		instance.addItem(newBookmark("folder", 0, { path: "Inbox" }));
		await instance.saveData();
		expect(parseBookmarks(files[".obsidian/bookmarks.json"])!.items).toMatchObject([{ type: "folder", path: "Inbox" }]);
	});

	test("a broken file on disk is left alone and the bookmarks stay as they were", async () => {
		const { app, writes, files } = fakeVault({ ".obsidian/bookmarks.json": OBSIDIAN });
		const instance = new BookmarksInstance(app);
		await instance.load();
		files[".obsidian/bookmarks.json"] = '{"items": [';
		await instance.saveData();
		expect(instance.items).toHaveLength(3);
		expect(writes).toEqual([]);
	});
});

