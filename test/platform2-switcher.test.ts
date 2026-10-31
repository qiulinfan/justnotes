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
	"281notes/README.md",
	"eecs595-nlp/project/final_report/grad.png",
	"281notes/FinalReview.md",
	"czech315-czech-cinema/13(Romance + Pupendo)/01_电影transcript/pupendo.cs",
	"281notes/docs/notes-01-08.md",
	"eecs542-advanced_cv/论文s/00-resnet.md",
	"math526-stochastic_process/final.md",
	"README.md",
].map(fileAt);

// The modal's DOM is not needed to rank: getSuggestions reads only the items
// and their text.
let ignored: string[] = [];
const app = { metadataCache: { isUserIgnored: (path: string) => ignored.some((prefix) => path.startsWith(prefix)) } };
const switcher = { app, getItems: () => files, getItemText: QuickSwitcher.prototype.getItemText } as unknown as QuickSwitcher;
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
		expect(final.indexOf("eecs595-nlp/project/final_report/grad.png")).toBeGreaterThan(1);
	});

	test("an exact name leads, and files that share a name rank by their whole path", () => {
		// getItems lists FinalReview and 281notes/README first, as more recent.
		expect(suggest("final").slice(0, 2).map((row) => row.text)).toEqual(["math526-stochastic_process/final", "281notes/FinalReview"]);
		expect(suggest("readme").map((row) => row.text)).toEqual(["README", "281notes/README"]);
	});

	test("a folder's name still finds the files in it first", () => {
		// pupendo.cs holds d, o, c and s in order, but not "docs".
		expect(suggest("docs")[0]).toEqual({ text: "281notes/docs/notes-01-08", highlighted: "docs" });
		expect(suggest("stochastic final")[0].text).toBe("math526-stochastic_process/final");
	});

	test("excluded files rank after the others", () => {
		ignored = ["math526-"];
		try {
			const final = suggest("final").map((row) => row.text);
			expect(final[0]).toBe("281notes/FinalReview");
			expect(final.at(-1)).toBe("math526-stochastic_process/final");
		} finally {
			ignored = [];
		}
	});
});
