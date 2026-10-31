import type { App } from "../../api/app";
import { SettingTab } from "../../api/plugin";
import { Setting } from "../../api/ui/setting";

// The Terminal core plugin's options, kept in localStorage (`terminal-settings`)
// like justnotes' other state, and shown under Core plugins in Settings.
export interface TerminalSettings {
	// Empty: the login shell ($SHELL).
	shell: string;
	// Null: Ghostty's font-size, else 13.
	fontSize: number | null;
	useGhostty: boolean;
	// Where "Open terminal" starts: the vault's folder or the active note's.
	cwd: "vault" | "active";
	copyOnSelect: boolean;
	scrollback: number;
}

export const DEFAULT_SETTINGS: TerminalSettings = { shell: "", fontSize: null, useGhostty: true, cwd: "vault", copyOnSelect: false, scrollback: 10000 };

export function readSettings(raw: unknown): TerminalSettings {
	const s = (raw && typeof raw === "object" ? raw : {}) as Partial<TerminalSettings>;
	const size = Number(s.fontSize);
	const scrollback = Number(s.scrollback);
	return {
		shell: typeof s.shell === "string" ? s.shell : DEFAULT_SETTINGS.shell,
		fontSize: s.fontSize !== null && size >= 6 && size <= 72 ? size : null,
		useGhostty: typeof s.useGhostty === "boolean" ? s.useGhostty : DEFAULT_SETTINGS.useGhostty,
		cwd: s.cwd === "active" ? "active" : "vault",
		copyOnSelect: s.copyOnSelect === true,
		scrollback: scrollback >= 0 && scrollback <= 1_000_000 ? Math.floor(scrollback) : DEFAULT_SETTINGS.scrollback,
	};
}

export interface SettingsOwner {
	settings: TerminalSettings;
	saveSettings(): void;
	ghosttyFiles(): string[];
}

export class TerminalSettingTab extends SettingTab {
	owner: SettingsOwner;

	constructor(app: App, owner: SettingsOwner) {
		super(app);
		this.owner = owner;
		this.id = "terminal";
		this.name = "Terminal";
	}

	display() {
		const { containerEl, owner } = this;
		const settings = owner.settings;
		containerEl.empty();
		const change = (apply: () => void) => {
			apply();
			owner.saveSettings();
		};
		new Setting(containerEl)
			.setName("Shell")
			.setDesc(`The program a new terminal runs, as a login shell. Empty for your login shell (${process.env.SHELL || "the account's shell"}).`)
			.addText((text) =>
				text
					.setPlaceholder(process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh")
					.setValue(settings.shell)
					.onChange((value) => change(() => (settings.shell = value.trim()))),
			);
		new Setting(containerEl)
			.setName("Starting folder")
			.setDesc("Where Open terminal starts. Open terminal in current folder always starts in the active note's folder.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("vault", "Vault folder")
					.addOption("active", "Active note's folder")
					.setValue(settings.cwd)
					.onChange((value) => change(() => (settings.cwd = value === "active" ? "active" : "vault"))),
			);
		const files = owner.ghosttyFiles();
		new Setting(containerEl)
			.setName("Use Ghostty's config")
			.setDesc(
				files.length
					? `Fonts, colours, cursor and background image from ${files.join(", ")}, re-read when it changes.`
					: "No Ghostty config was found; terminals use the theme's colours.",
			)
			.addToggle((toggle) => toggle.setValue(settings.useGhostty).onChange((value) => change(() => (settings.useGhostty = value))));
		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Empty for Ghostty's font-size, or 13.")
			.addText((text) =>
				text
					.setPlaceholder("13")
					.setValue(settings.fontSize === null ? "" : String(settings.fontSize))
					.onChange((value) =>
						change(() => {
							const size = Number(value);
							settings.fontSize = value.trim() && size >= 6 && size <= 72 ? size : null;
						}),
					),
			);
		new Setting(containerEl)
			.setName("Copy on select")
			.setDesc("Selecting text in a terminal copies it.")
			.addToggle((toggle) => toggle.setValue(settings.copyOnSelect).onChange((value) => change(() => (settings.copyOnSelect = value))));
		new Setting(containerEl)
			.setName("Scrollback")
			.setDesc("Lines kept above the screen.")
			.addText((text) =>
				text.setValue(String(settings.scrollback)).onChange((value) =>
					change(() => {
						const lines = Number(value);
						if (value.trim() && lines >= 0 && lines <= 1_000_000) settings.scrollback = Math.floor(lines);
					}),
				),
			);
	}
}
