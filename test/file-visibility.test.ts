import { describe, expect, test } from "bun:test";
import { isFileShown } from "../src/api/file-visibility";

const appWith = (showAll: boolean, registered: string[] = []) =>
	({
		vault: { getConfig: (key: string) => (key === "showUnsupportedFiles" ? showAll : undefined) },
		viewRegistry: { isExtensionRegistered: (ext: string) => registered.includes(ext) },
	}) as any;
const shown = (app: any, name: string) => isFileShown(app, { extension: name.slice(name.lastIndexOf(".") + 1) } as any);

// With "Detect all file extensions" off (the default) the explorer and the
// quick switcher hid .txt and, without a plugin's view, .tex files, which
// are first-class in justnotes.
describe("which files the explorer and quick switcher show", () => {
	test("notes, TeX, text and media files show with the setting off; other files only with it on or a view for them", () => {
		const off = appWith(false, ["py"]);
		for (const name of ["a.md", "b.tex", "c.TXT", "d.png", "e.mp3", "f.mp4", "g.pdf"]) expect(shown(off, name)).toBe(true);
		expect(shown(appWith(false), "h.py")).toBe(false);
		expect(shown(off, "h.py")).toBe(true);
		expect(shown(appWith(true), "i.zip")).toBe(true);
	});
});
