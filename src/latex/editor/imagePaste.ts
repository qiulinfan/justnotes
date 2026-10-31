import { EditorView } from "@codemirror/view";
import { dirname, relative, sep } from "path";
import type { App } from "../../api/app";
import { importFile } from "../../api/attachments";
import { Modal } from "../../api/ui/modal";
import { Notice } from "../../api/ui/notice";
import { Setting } from "../../api/ui/setting";
import type { TFile } from "../../api/vault";

// justnotes' own: an image pasted into a TeX editor is saved as an
// attachment (the attachment folder rules of api/attachments.ts) and goes in
// as LaTeX at the cursor, through a small form (path, width, caption, label,
// placement, figure or a bare \includegraphics). Pasted text stays plain.

export const WIDTH_PRESETS = [1, 0.75, 0.5, 0.33];
export const PLACEMENTS = ["htbp", "h", "t", "b", "p", "H"];

export interface FigureOptions {
	/** The image's path as \includegraphics takes it. */
	path: string;
	/** A fraction of \linewidth; 1 is \linewidth itself. */
	width: number;
	figure: boolean;
	caption: string;
	label: string;
	placement: string;
}

// `0.5\linewidth`, `\linewidth` for a whole one; a width that is no positive
// number up to 1 is \linewidth.
function widthOf(width: number) {
	const w = Number.isFinite(width) && width > 0 && width < 1 ? Number(width.toFixed(3)) : 1;
	return w === 1 ? "\\linewidth" : `${w}\\linewidth`;
}

/** The LaTeX inserted for a pasted image: a figure environment, or the bare \includegraphics. */
export function figureLatex(o: FigureOptions): string {
	const graphic = `\\includegraphics[width=${widthOf(o.width)}]{${o.path}}`;
	if (!o.figure) return graphic;
	const lines = [`\\begin{figure}${o.placement ? `[${o.placement}]` : ""}`, "  \\centering", `  ${graphic}`];
	if (o.caption.trim()) lines.push(`  \\caption{${o.caption.trim()}}`);
	if (o.label.trim()) lines.push(`  \\label{${o.label.trim()}}`);
	lines.push("\\end{figure}");
	return lines.join("\n");
}

/**
 * The image's path for \includegraphics: relative to the root document's folder, where TeX
 * reads it from, with forward slashes; an image outside that folder gets a path with `..`.
 */
export function graphicsPath(rootFile: string, imageFile: string): string {
	return relative(dirname(rootFile), imageFile).split(sep).join("/");
}

/** A label for the image's file name: `fig:` and its letters, digits and dashes. */
export function defaultLabel(name: string): string {
	const stem = name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return `fig:${stem || "image"}`;
}

/** The form. Enter or Insert puts in what it says; Escape puts in the bare \includegraphics. */
export class FigureModal extends Modal {
	#options: FigureOptions;
	#insert: (latex: string) => void;
	#done = false;

	constructor(app: App, path: string, label: string, insert: (latex: string) => void) {
		super(app);
		this.#options = { path, width: 1, figure: true, caption: "", label, placement: "htbp" };
		this.#insert = insert;
	}

	onOpen() {
		const o = this.#options;
		this.setTitle("Insert pasted image");
		this.modalEl.addClass("ll-figure-modal");
		const { contentEl } = this;
		contentEl.createDiv({ cls: "ll-figure-path", text: o.path });
		let widthText: { setValue(v: string): unknown } | null = null;
		new Setting(contentEl)
			.setName("Width")
			.setDesc("A fraction of \\linewidth.")
			.addText((t) => {
				widthText = t;
				t.setValue(String(o.width)).onChange((v) => {
					o.width = Number(v);
				});
				t.inputEl.addClass("ll-figure-width");
			})
			.then((setting) => {
				for (const preset of WIDTH_PRESETS) {
					setting.addButton((b) =>
						b.setButtonText(String(preset)).onClick(() => {
							o.width = preset;
							widthText?.setValue(String(preset));
						}),
					);
				}
			});
		const figureOnly: Setting[] = [];
		new Setting(contentEl).setName("Figure environment").addToggle((t) =>
			t.setValue(o.figure).onChange((v) => {
				o.figure = v;
				for (const s of figureOnly) s.settingEl.toggle(v);
			}),
		);
		figureOnly.push(
			new Setting(contentEl).setName("Caption").addText((t) => {
				t.onChange((v) => (o.caption = v));
				window.setTimeout(() => t.inputEl.focus());
			}),
			new Setting(contentEl).setName("Label").addText((t) => t.setValue(o.label).onChange((v) => (o.label = v))),
			new Setting(contentEl).setName("Placement").addDropdown((d) => {
				for (const p of PLACEMENTS) d.addOption(p, p);
				d.setValue(o.placement).onChange((v) => (o.placement = v));
			}),
		);
		new Setting(contentEl).addButton((b) => b.setButtonText("Insert").setCta().onClick(() => this.#finish()));
		this.scope.register([], "Enter", (evt) => {
			// Enter in a dropdown picks its option.
			if ((evt.target as HTMLElement | null)?.tagName === "SELECT") return true;
			this.#finish();
			return false;
		});
	}

	// Closing any other way (Escape, the close button, a click outside) puts
	// in the bare \includegraphics: the image is already saved.
	onClose() {
		this.contentEl.empty();
		if (!this.#done) {
			this.#done = true;
			this.#insert(figureLatex({ ...this.#options, figure: false }));
		}
	}

	#finish() {
		if (this.#done) return;
		this.#done = true;
		this.#insert(figureLatex(this.#options));
		this.close();
	}
}

export interface ImagePasteHost {
	app: App;
	/** The TeX file being edited. */
	file: () => TFile | null;
	/** Absolute paths: of a vault path, and the root document of a file. */
	absolutePath: (vaultPath: string) => string;
	rootFor: (abs: string) => string;
}

/** The TeX editor's paste handler: images go through the form, everything else is left alone. */
export function imagePaste(host: ImagePasteHost) {
	return EditorView.domEventHandlers({
		paste: (evt, view) => {
			const file = host.file();
			const image = [...(evt.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
			if (!file || file.extension !== "tex" || !image) return false;
			evt.preventDefault();
			const { from, to } = view.state.selection.main;
			void (async () => {
				let saved: TFile;
				try {
					saved = await importFile(host.app, image, file.path, true);
				} catch (err) {
					new Notice(`LaTeX Live: the pasted image could not be saved: ${err instanceof Error ? err.message : String(err)}`);
					return;
				}
				const abs = host.absolutePath(file.path);
				const path = graphicsPath(host.rootFor(abs), host.absolutePath(saved.path));
				new FigureModal(host.app, path, defaultLabel(saved.name), (latex) => {
					// The text may have changed meanwhile: insert where the selection maps to.
					const doc = view.state.doc;
					const at = Math.min(from, doc.length);
					const end = Math.min(Math.max(to, at), doc.length);
					view.dispatch({ changes: { from: at, to: end, insert: latex }, selection: { anchor: at + latex.length }, scrollIntoView: true, userEvent: "input.paste" });
					view.focus();
				}).open();
			})();
			return true;
		},
	});
}
