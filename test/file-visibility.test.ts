import { describe, expect, test } from "bun:test";
import { isFileShown } from "../src/api/file-visibility";

const appWith = (showAll: boolean, registered: string[] = []) =>
	({
		vault: { getConfig: (key: string) => (key === "showUnsupportedFiles" ? showAll : undefined) },
		viewRegistry: { isExtensionRegistered: (ext: string) => registered.includes(ext) },
	}) as any;
const shown = (app: any, name: string) => isFileShown(app, { extension: name.slice(name.lastIndexOf(".") + 1) } as any);

// With "Detect all file extensions" off the explorer and the quick switcher
// hid .txt and, without a plugin's view, .tex files, which are first-class in
// justnotes. (justnotes turns the setting on by default.)
describe("which files the explorer and quick switcher show", () => {
	test("notes, TeX, text, media and code files show with the setting off; other files only with it on or a view for them", () => {
		const off = appWith(false, ["xyz"]);
		for (const name of ["a.md", "b.tex", "c.TXT", "d.png", "e.mp3", "f.mp4", "g.pdf", "h.py", "i.json"]) expect(shown(off, name)).toBe(true);
		expect(shown(appWith(false), "j.xyz")).toBe(false);
		expect(shown(off, "j.xyz")).toBe(true);
		expect(shown(appWith(true), "i.zip")).toBe(true);
	});
});
