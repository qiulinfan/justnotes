// A signature for a PDF: drawn with the pointer or typed in a script face,
// or one used before. It becomes a PNG with a transparent background,
// cropped to the ink, which the view puts on the page as an image
// annotation. The last few are kept per viewer (localStorage).
import type { App } from "../../api/app";
import { setIcon } from "../../api/icons";
import { Modal } from "../../api/ui/modal";

const SAVED = "justnotes-pdf-signatures";
const KEEP = 5;
const SCRIPT_FONT = '"Snell Roundhand", "Apple Chancery", "Zapfino", "Brush Script MT", "Segoe Script", cursive';

export class SignatureModal extends Modal {
	#onDone: (png: Uint8Array) => void;
	#mode: "draw" | "type" = "draw";
	#canvas!: HTMLCanvasElement;
	#typed = "";
	#drawn = false;

	constructor(app: App, onDone: (png: Uint8Array) => void) {
		super(app);
		this.#onDone = onDone;
	}

	onOpen() {
		this.titleEl.setText("Add a signature");
		this.modalEl.addClass("pdf-signature-modal");
		const saved = savedSignatures(this.app);
		if (saved.length) {
			const list = this.contentEl.createDiv("pdf-signature-saved");
			for (const url of saved) {
				const item = list.createDiv("pdf-signature-saved-item");
				const img = item.createEl("img", { attr: { src: url, alt: "Saved signature" } });
				img.addEventListener("click", () => void this.#finish(dataUrlBytes(url)));
				const remove = item.createDiv({ cls: "clickable-icon pdf-signature-remove", attr: { "aria-label": "Forget this signature" } });
				setIcon(remove, "x");
				remove.addEventListener("click", () => {
					this.app.saveLocalStorage(
						SAVED,
						savedSignatures(this.app).filter((u) => u !== url),
					);
					item.remove();
				});
			}
		}
		const tabs = this.contentEl.createDiv("pdf-signature-tabs");
		const draw = tabs.createEl("button", { text: "Draw", cls: "is-active" });
		const type = tabs.createEl("button", { text: "Type" });
		this.#canvas = this.contentEl.createEl("canvas", { cls: "pdf-signature-canvas" });
		this.#canvas.width = 1000;
		this.#canvas.height = 360;
		const input = this.contentEl.createEl("input", { cls: "pdf-signature-input", attr: { type: "text", placeholder: "Type your name" } });
		input.hide();
		input.addEventListener("input", () => {
			this.#typed = input.value;
			this.#renderTyped();
		});
		draw.addEventListener("click", () => {
			this.#mode = "draw";
			draw.addClass("is-active");
			type.removeClass("is-active");
			input.hide();
			this.#clear();
		});
		type.addEventListener("click", () => {
			this.#mode = "type";
			type.addClass("is-active");
			draw.removeClass("is-active");
			input.show();
			input.focus();
			this.#renderTyped();
		});
		this.#bindDrawing();
		const buttons = this.contentEl.createDiv("modal-button-container");
		buttons.createEl("button", { text: "Clear" }).addEventListener("click", () => {
			input.value = this.#typed = "";
			this.#clear();
		});
		const add = buttons.createEl("button", { text: "Add", cls: "mod-cta" });
		add.addEventListener("click", () => {
			const png = this.#png();
			if (png) void this.#finish(png, true);
		});
	}

	onClose() {
		this.contentEl.empty();
	}

	async #finish(png: Uint8Array, remember = false) {
		if (remember) {
			const url = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
			this.app.saveLocalStorage(SAVED, [url, ...savedSignatures(this.app).filter((u) => u !== url)].slice(0, KEEP));
		}
		this.close();
		this.#onDone(png);
	}

	#clear() {
		const ctx = this.#canvas.getContext("2d")!;
		ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
		this.#drawn = false;
	}

	#bindDrawing() {
		const canvas = this.#canvas;
		const ctx = canvas.getContext("2d")!;
		let last: [number, number] | null = null;
		const at = (evt: PointerEvent): [number, number] => {
			const r = canvas.getBoundingClientRect();
			return [((evt.clientX - r.left) / r.width) * canvas.width, ((evt.clientY - r.top) / r.height) * canvas.height];
		};
		canvas.addEventListener("pointerdown", (evt) => {
			if (this.#mode !== "draw") return;
			canvas.setPointerCapture(evt.pointerId);
			last = at(evt);
		});
		canvas.addEventListener("pointermove", (evt) => {
			if (!last || this.#mode !== "draw") return;
			const next = at(evt);
			ctx.strokeStyle = "#111";
			ctx.lineWidth = 5;
			ctx.lineCap = ctx.lineJoin = "round";
			ctx.beginPath();
			ctx.moveTo(...last);
			ctx.lineTo(...next);
			ctx.stroke();
			last = next;
			this.#drawn = true;
		});
		const end = () => (last = null);
		canvas.addEventListener("pointerup", end);
		canvas.addEventListener("pointercancel", end);
	}

	#renderTyped() {
		this.#clear();
		if (!this.#typed.trim()) return;
		const ctx = this.#canvas.getContext("2d")!;
		let size = 150;
		ctx.fillStyle = "#111";
		ctx.textBaseline = "middle";
		do {
			ctx.font = `${size}px ${SCRIPT_FONT}`;
			size -= 6;
		} while (ctx.measureText(this.#typed).width > this.#canvas.width - 60 && size > 20);
		ctx.fillText(this.#typed, 30, this.#canvas.height / 2);
		this.#drawn = true;
	}

	#png() {
		if (!this.#drawn) return null;
		const cropped = trimCanvas(this.#canvas);
		return cropped ? dataUrlBytes(cropped.toDataURL("image/png")) : null;
	}
}

// The canvas cut to its painted pixels, with a small margin; null when blank.
export function trimCanvas(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext("2d")!;
	const { width, height } = canvas;
	const data = ctx.getImageData(0, 0, width, height).data;
	let top = height;
	let left = width;
	let right = -1;
	let bottom = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] === 0) continue;
			if (x < left) left = x;
			if (x > right) right = x;
			if (y < top) top = y;
			if (y > bottom) bottom = y;
		}
	}
	if (right < 0) return null;
	const pad = 8;
	left = Math.max(0, left - pad);
	top = Math.max(0, top - pad);
	right = Math.min(width - 1, right + pad);
	bottom = Math.min(height - 1, bottom + pad);
	const out = canvas.ownerDocument.createElement("canvas");
	out.width = right - left + 1;
	out.height = bottom - top + 1;
	out.getContext("2d")!.drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
	return out;
}

function savedSignatures(app: App): string[] {
	const stored = app.loadLocalStorage(SAVED);
	return Array.isArray(stored) ? stored.filter((u) => typeof u === "string" && u.startsWith("data:image/png;base64,")) : [];
}

function dataUrlBytes(url: string) {
	return new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
}
