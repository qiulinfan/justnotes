import { describe, expect, test } from "bun:test";
import type { TFile } from "../src/api/vault";
import { QuickSwitcher } from "../src/renderer/views";

function fileAt(path: string) {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return { path, name, basename: name.slice(0, dot), extension: name.slice(dot + 1) } as TFile;
}

// Paths from a courses vault, in the order getItems lists them (recent first).
const files = [
	"Zelda/Assets/Resources/NES - The Legend of Zelda - Miscellaneous - HUD & Pause Screen.png",
	"eecs595-nlp/project/final_report/grad.png",
	"281notes/FinalReview.md",
	"czech315-czech-cinema/13(Romance + Pupendo)/01_电影transcript/pupendo.cs",
	"281notes/docs/notes-01-08.md",
	"eecs542-advanced_cv/论文s/00-resnet.md",
	"math526-stochastic_process/final.md",
].map(fileAt);

// The modal's DOM is not needed to rank: getSuggestions reads only the items
// and their text.
const switcher = { getItems: () => files, getItemText: QuickSwitcher.prototype.getItemText } as unknown as QuickSwitcher;
const suggest = (query: string) =>
	QuickSwitcher.prototype.getSuggestions.call(switcher, query).map(({ item, match }) => {
		const text = switcher.getItemText(item);
		return { text, highlighted: match.matches.map(([from, to]) => text.slice(from, to)).join("") };
	});

describe("QuickSwitcher ranking", () => {
	test("a file whose name holds the query ranks above paths that only scatter its letters", () => {
		const resnet = suggest("resnet");
		expect(resnet[0]).toEqual({ text: "eecs542-advanced_cv/论文s/00-resnet", highlighted: "resnet" });
		const final = suggest("final").map((row) => row.text);
		expect(final.slice(0, 2).sort()).toEqual(["281notes/FinalReview", "math526-stochastic_process/final"]);
		expect(final.indexOf("eecs595-nlp/project/final_report/grad.png")).toBeGreaterThan(1);
	});

	test("a folder's name still finds the files in it first", () => {
		// pupendo.cs holds d, o, c and s in order, but not "docs".
		expect(suggest("docs")[0]).toEqual({ text: "281notes/docs/notes-01-08", highlighted: "docs" });
		expect(suggest("stochastic final")[0].text).toBe("math526-stochastic_process/final");
	});
});
