import * as fs from "node:fs";
import * as os from "node:os";
import { ipcRenderer, webUtils } from "electron";
import type { App } from "../../api/app";
import { FileSystemAdapter } from "../../api/vault";
import { type TerminalAppearance, terminalAppearance, type ThemeColors } from "./appearance";
import { type GhosttyConfig, ghosttyConfigFiles, readGhosttyConfig } from "./ghostty-config";
import { readSettings, type TerminalSettings } from "./settings";
import type { TerminalView } from "./terminal-view";

type SpawnReply = { id: number; pid: number; shell: string } | { error: string };

// What the terminal views share while the Terminal core plugin is on: the
// pseudoterminals in main (by id), the settings, and the look made from
// Ghostty's config, which is watched and re-read when it changes.
export class TerminalService {
	app: App;
	settings: TerminalSettings;
	appearance: TerminalAppearance;
	config: GhosttyConfig | null = null;
	home = os.homedir();
	views = new Set<TerminalView>();
	// The terminal that last had the keyboard, for Toggle terminal.
	lastFocused: TerminalView | null = null;
	#byPty = new Map<number, TerminalView>();
	#images = new Map<string, string | null>();
	#watched = new Set<string>();
	#reloadTimer: number | null = null;
	#onData = (_evt: unknown, id: number, data: string) => this.#byPty.get(id)?.write(data);
	#onExit = (_evt: unknown, id: number, code: number) => {
		const view = this.#byPty.get(id);
		this.#byPty.delete(id);
		view?.onExit(code);
	};

	constructor(app: App) {
		this.app = app;
		this.settings = readSettings(app.loadLocalStorage("terminal-settings"));
		this.#loadConfig();
		this.appearance = this.#makeAppearance();
		ipcRenderer.on("justnotes:pty-data", this.#onData);
		ipcRenderer.on("justnotes:pty-exit", this.#onExit);
	}

	destroy() {
		ipcRenderer.off("justnotes:pty-data", this.#onData);
		ipcRenderer.off("justnotes:pty-exit", this.#onExit);
		for (const file of this.#watched) fs.unwatchFile(file);
		this.#watched.clear();
		if (this.#reloadTimer !== null) window.clearTimeout(this.#reloadTimer);
		for (const url of this.#images.values()) if (url) URL.revokeObjectURL(url);
		this.#images.clear();
	}

	vaultRoot() {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.home;
	}

	fullPath(vaultPath: string) {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getFullPath(vaultPath) : vaultPath;
	}

	pathOfDroppedFile(file: File) {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	}

	async spawn(view: TerminalView, cwd: string, cols: number, rows: number): Promise<SpawnReply> {
		const reply: SpawnReply = await ipcRenderer.invoke("justnotes:pty-spawn", { shell: this.settings.shell, cwd, cols, rows });
		if ("id" in reply) {
			// Closed while the shell was starting.
			if (!this.views.has(view)) {
				this.kill(reply.id);
				return { error: "closed" };
			}
			this.#byPty.set(reply.id, view);
		}
		return reply;
	}

	input(id: number, data: string) {
		ipcRenderer.send("justnotes:pty-input", id, data);
	}

	resize(id: number, cols: number, rows: number) {
		ipcRenderer.send("justnotes:pty-resize", id, cols, rows);
	}

	ack(id: number, count: number) {
		ipcRenderer.send("justnotes:pty-ack", id, count);
	}

	kill(id: number) {
		this.#byPty.delete(id);
		ipcRenderer.send("justnotes:pty-kill", id);
	}

	saveSettings() {
		this.app.saveLocalStorage("terminal-settings", this.settings);
		this.refresh();
	}

	// Ghostty's config files, as found when last read.
	ghosttyFiles() {
		return this.config?.files ?? [];
	}

	// The look again, after a settings, theme or Ghostty config change.
	refresh() {
		this.appearance = this.#makeAppearance();
		for (const view of this.views) view.applyAppearance(this.appearance);
	}

	// A background image as a blob: URL, which popout windows (same origin,
	// no file access of their own) can show too. Null when it cannot be read.
	imageUrl(path: string) {
		if (this.#images.has(path)) return this.#images.get(path) ?? null;
		let url: string | null = null;
		try {
			url = URL.createObjectURL(new Blob([fs.readFileSync(path)]));
		} catch {}
		this.#images.set(path, url);
		return url;
	}

	#themeColors(): ThemeColors {
		const style = getComputedStyle(document.body);
		const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
		const foreground = read("--text-normal", "#dcddde");
		return {
			background: read("--background-primary", "#1e1e1e"),
			foreground,
			selection: read("--text-selection", "#4a5a7a88"),
			cursor: read("--text-accent", foreground),
		};
	}

	#makeAppearance() {
		const config = this.settings.useGhostty ? this.config : null;
		return terminalAppearance(config, this.#themeColors(), { fontSize: this.settings.fontSize });
	}

	#loadConfig() {
		const candidates = ghosttyConfigFiles(this.home, process.env, process.platform);
		const read = (file: string) => {
			try {
				return fs.readFileSync(file, "utf8");
			} catch {
				return null;
			}
		};
		this.config = readGhosttyConfig(candidates, read, this.home);
		for (const url of this.#images.values()) if (url) URL.revokeObjectURL(url);
		this.#images.clear();
		// Polled, so a file an editor replaces, or one created later, is seen.
		for (const file of new Set([...candidates, ...(this.config?.files ?? [])])) {
			if (this.#watched.has(file)) continue;
			this.#watched.add(file);
			fs.watchFile(file, { interval: 2000, persistent: false }, () => this.#configChanged());
		}
	}

	#configChanged() {
		if (this.#reloadTimer !== null) window.clearTimeout(this.#reloadTimer);
		this.#reloadTimer = window.setTimeout(() => {
			this.#reloadTimer = null;
			this.#loadConfig();
			this.refresh();
		}, 200);
	}
}
