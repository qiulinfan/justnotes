import { describe, expect, test } from "bun:test";
import { defaultLabel, figureLatex, graphicsPath } from "../../src/latex/editor/imagePaste";

// What a pasted image becomes in a TeX file (justnotes' own, not latex-live's).
describe("pasted images in TeX", () => {
	const base = { path: "figures/Pasted image 1.png", width: 0.5, caption: "A plot", label: "fig:plot", placement: "htbp" };

	test("the form's figure: placement, centering, width as a fraction of \\linewidth, caption and label", () => {
		expect(figureLatex({ ...base, figure: true })).toBe(
			"\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.5\\linewidth]{figures/Pasted image 1.png}\n  \\caption{A plot}\n  \\label{fig:plot}\n\\end{figure}",
		);
	});

	test("an empty caption or label is left out; a whole or invalid width is \\linewidth; bare is the graphic alone", () => {
		expect(figureLatex({ ...base, figure: true, caption: " ", label: "", width: 1 })).toBe(
			"\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=\\linewidth]{figures/Pasted image 1.png}\n\\end{figure}",
		);
		expect(figureLatex({ ...base, figure: false, width: Number.NaN })).toBe("\\includegraphics[width=\\linewidth]{figures/Pasted image 1.png}");
		expect(figureLatex({ ...base, figure: false, width: 0.33 })).toBe("\\includegraphics[width=0.33\\linewidth]{figures/Pasted image 1.png}");
	});

	test("the path is relative to the root document's folder, as TeX reads it", () => {
		expect(graphicsPath("/v/book/main.tex", "/v/book/chapters/attachments/a.png")).toBe("chapters/attachments/a.png");
		expect(graphicsPath("/v/book/main.tex", "/v/attachments/a.png")).toBe("../attachments/a.png");
	});

	test("the label comes from the file name", () => {
		expect(defaultLabel("Pasted image 20261031120000.png")).toBe("fig:pasted-image-20261031120000");
	});
});
