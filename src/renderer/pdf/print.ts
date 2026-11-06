// Printing a PDF as pdf.js's own viewer does: every page rendered for
// printing at 150 dpi, with the annotations and form values not yet saved
// (the print annotation storage), as images of a page in a hidden window,
// printed through Electron's webContents.print (the system's dialog), whose
// callback says whether it printed, was cancelled or failed. The window and
// the images go after.
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { getElectron } from "../../api/dom";

const DPI = 150;

export interface PrintResult {
	printed: boolean;
	// Electron's reason when it did not print ("cancelled" when the dialog was).
	reason: string;
}

export async function printPdf(doc: any, lib: any, progress: (done: number, total: number) => void = () => {}, options: Record<string, unknown> = {}): Promise<PrintResult> {
	const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "justnotes-print-"));
	const { remote } = getElectron();
	let win: any = null;
	try {
		const storage = doc.annotationStorage.print;
		const pages: string[] = [];
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const viewport = page.getViewport({ scale: DPI / 72 });
			const canvas = document.createElement("canvas");
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			const ctx = canvas.getContext("2d")!;
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			await page.render({ canvasContext: ctx, viewport, intent: "print", annotationMode: lib.AnnotationMode.ENABLE_STORAGE, printAnnotationStorage: storage }).promise;
			const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render a page"))), "image/png"));
			const file = `page-${n}.png`;
			fs.writeFileSync(nodePath.join(dir, file), Buffer.from(await blob.arrayBuffer()));
			pages.push(`<img src="${file}">`);
			page.cleanup?.();
			progress(n, doc.numPages);
		}
		const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(doc._pdfInfo?.title ?? "PDF")}</title><style>
@page { margin: 0; }
html, body { margin: 0; padding: 0; background: white; }
img { display: block; width: 100%; height: auto; break-after: page; page-break-after: always; }
img:last-child { break-after: auto; page-break-after: auto; }
</style></head><body>${pages.join("")}</body></html>`;
		const htmlPath = nodePath.join(dir, "print.html");
		fs.writeFileSync(htmlPath, html);
		win = new remote.BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
		await win.loadFile(htmlPath);
		return await new Promise<PrintResult>((resolve) => {
			win.webContents.print({ printBackground: true, ...options }, (printed: boolean, reason: string) => resolve({ printed, reason: reason ?? "" }));
		});
	} finally {
		if (win && !win.isDestroyed()) win.destroy();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
