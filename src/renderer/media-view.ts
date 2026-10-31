import type { App } from "../api/app";
import { AUDIO_EXTENSIONS, createMediaPlayer, VIDEO_EXTENSIONS } from "../api/markdown";
import type { TFile } from "../api/vault";
import { FileView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

// Obsidian's audio and video views: such a file opens in a tab that plays it
// (the Audio recorder opens a recording made with no note open), instead of
// in the system's default app.
class MediaView extends FileView {
	kind: "audio" | "video";

	constructor(leaf: WorkspaceLeaf, kind: "audio" | "video") {
		super(leaf);
		this.kind = kind;
		this.contentEl.addClass(`${kind}-container`);
	}

	getViewType() {
		return this.kind;
	}

	getIcon() {
		return this.kind === "audio" ? "file-headphone" : "file-play";
	}

	canAcceptExtension(extension: string) {
		return (this.kind === "audio" ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS).has(extension);
	}

	async onLoadFile(file: TFile) {
		this.contentEl.empty();
		createMediaPlayer(this.contentEl, this.app.vault.getResourcePath(file), this.kind === "video");
	}

	async onUnloadFile() {
		this.contentEl.empty();
	}
}

export function registerMediaViews(app: App) {
	app.viewRegistry.registerViewWithExtensions([...AUDIO_EXTENSIONS], "audio", (leaf) => new MediaView(leaf, "audio"));
	app.viewRegistry.registerViewWithExtensions([...VIDEO_EXTENSIONS], "video", (leaf) => new MediaView(leaf, "video"));
}
