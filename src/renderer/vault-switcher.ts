import * as path from "node:path";
import { ipcRenderer } from "electron";
import type { App } from "../api/app";
import { setIcon } from "../api/icons";
import { Menu } from "../api/ui/menu";
import { Modal } from "../api/ui/modal";
import { Notice } from "../api/ui/notice";
import { Setting } from "../api/ui/setting";
import type { VaultResult, VaultRow } from "../main/vault-switcher";

// Obsidian's vault profile at the bottom of the left sidebar: the vault's
// name with a chevron, which opens the vault menu, and the help and settings
// buttons. The vaults, and everything that opens, adds or forgets one, live
// in main (main/vault-switcher.ts), which owns vaults.json and the windows.

// justnotes' own page, which says what works; Obsidian's help would describe
// features justnotes does not have.
const HELP_URL = "https://github.com/qiulinfan/justnotes";
const revealLabel = process.platform === "darwin" ? "Reveal in Finder" : process.platform === "win32" ? "Show in system explorer" : "Show in folder";

const listVaults = (): Promise<VaultRow[]> => ipcRenderer.invoke("justnotes:vaults");

function report(result: VaultResult) {
	if (result && "error" in result) new Notice(result.error);
	return !!result && "vault" in result;
}

// A listed vault's window opens, or comes to the front.
async function switchTo(row: VaultRow) {
	if (row.current) return;
	if (!(await ipcRenderer.invoke("justnotes:switch-vault", row.path))) new Notice(`Could not open ${row.shortPath}.`);
}

export async function openFolderAsVault() {
	return report(await ipcRenderer.invoke("justnotes:open-folder-as-vault"));
}

export function installVaultSwitcher(app: App) {
	const dock = app.workspace.leftSplit;
	const profile = createDiv("workspace-sidedock-vault-profile");
	const switcher = profile.createDiv({ cls: "workspace-drawer-vault-switcher", attr: { "aria-label": "Switch vault" } });
	setIcon(switcher.createDiv("workspace-drawer-vault-switcher-icon"), "chevrons-up-down");
	switcher.createDiv({ cls: "workspace-drawer-vault-name", text: app.vault.getName() });
	// A second click closes the menu.
	let menu: Menu | null = null;
	switcher.addEventListener("click", async () => {
		if (menu) return menu.hide();
		menu = await showVaultMenu(app, switcher);
		menu.onHide(() => (menu = null));
	});
	const actions = profile.createDiv("workspace-drawer-vault-actions");
	const help = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Help" } });
	setIcon(help, "help-circle");
	help.addEventListener("click", () => app.commands.executeCommandById("app:open-help"));
	const settings = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Settings" } });
	setIcon(settings, "settings");
	settings.addEventListener("click", () => app.setting.open());
	dock.footerEl = profile;
	dock.containerEl.appendChild(profile);

	app.commands.addCommand({ id: "app:open-vault", name: "Open another vault", callback: () => new VaultManagerModal(app).open() });
	app.commands.addCommand({ id: "app:open-help", name: "Open help", callback: () => window.open(HELP_URL, "_blank") });
}

// The known vaults, the current one checked, then Open another vault and
// Manage vaults, opening above the switcher.
async function showVaultMenu(app: App, anchor: HTMLElement) {
	const rows = await listVaults();
	const menu = new Menu();
	for (const row of rows) {
		menu.addItem((item) => {
			item.setTitle(row.label).setChecked(row.current).onClick(() => void switchTo(row));
			if (row.missing) item.setDisabled(true);
			item.dom.setAttr("aria-label", row.missing ? `${row.shortPath} (folder not found)` : row.shortPath);
		});
	}
	menu.addSeparator();
	menu.addItem((item) => item.setTitle("Open another vault…").setIcon("folder-open").onClick(() => void openFolderAsVault()));
	menu.addItem((item) => item.setTitle("Manage vaults…").setIcon("settings-2").onClick(() => new VaultManagerModal(app).open()));
	menu.setParentElement(anchor);
	const rect = anchor.getBoundingClientRect();
	menu.showAtPosition({ x: rect.left, y: rect.top, width: rect.width, overlap: true }, anchor.doc);
	// Above the switcher, as Obsidian's opens from the bottom of the sidebar.
	const top = rect.top - menu.dom.offsetHeight - 4;
	if (top >= 4) menu.dom.style.top = `${top}px`;
	return menu;
}

// Obsidian's vault manager as a dialog: the known vaults (open, reveal,
// remove from the list) and the ways to add one.
export class VaultManagerModal extends Modal {
	#listEl: HTMLElement;
	#location: string;

	constructor(app: App) {
		super(app);
		this.modalEl.addClass("mod-vault-manager");
		this.setTitle("Manage vaults");
		this.#location = path.dirname(app.vault.adapter.basePath);
		this.#listEl = this.contentEl.createDiv("vault-manager-list");

		new Setting(this.contentEl)
			.setName("Open folder as vault")
			.setDesc("Choose an existing folder of notes.")
			.addButton((b) => b.setButtonText("Open").onClick(async () => (await openFolderAsVault()) && this.close()));

		new Setting(this.contentEl).setName("Create new vault").setHeading();
		let name = "";
		const nameRow = new Setting(this.contentEl)
			.setName("Vault name")
			.addText((t) => {
				t.setPlaceholder("New vault").onChange((v) => {
					name = v;
					nameRow.setErrorMessage(null);
				});
				t.inputEl.addClass("vault-manager-name-input");
			});
		const locationRow = new Setting(this.contentEl).setName("Location").setDesc(this.#location);
		locationRow.addButton((b) =>
			b.setButtonText("Browse").onClick(async () => {
				const picked: string | null = await ipcRenderer.invoke("justnotes:pick-vault-location");
				if (!picked) return;
				this.#location = picked;
				locationRow.setDesc(picked);
			}),
		);
		const create = async () => {
			const result: VaultResult = await ipcRenderer.invoke("justnotes:create-vault", this.#location, name);
			if (result && "error" in result) return void nameRow.setErrorMessage(result.error);
			this.close();
		};
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Create").setCta().onClick(create));
		this.scope.register([], "Enter", () => {
			if (activeDocument.activeElement?.hasClass("vault-manager-name-input")) void create();
			return false;
		});
	}

	onOpen() {
		void this.#render();
	}

	async #render() {
		const rows = await listVaults();
		this.#listEl.empty();
		for (const row of rows) {
			const item = this.#listEl.createDiv("vault-manager-item");
			item.toggleClass("is-current", row.current);
			item.toggleClass("is-missing", row.missing);
			const info = item.createDiv("vault-manager-item-info");
			info.createDiv({ cls: "vault-manager-item-name", text: row.label });
			info.createDiv({ cls: "vault-manager-item-path", text: row.missing ? `${row.shortPath} (folder not found)` : row.shortPath });
			if (row.current) item.createDiv({ cls: "vault-manager-item-tag", text: "Current" });
			const actions = item.createDiv("vault-manager-item-actions");
			if (!row.current && !row.missing) {
				// A vault open in another window comes to the front.
				const open = actions.createEl("button", { text: row.open ? "Switch" : "Open" });
				open.addEventListener("click", async () => {
					await switchTo(row);
					this.close();
				});
			}
			const more = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "More options" } });
			setIcon(more, "more-horizontal");
			more.addEventListener("click", (evt) => {
				const menu = new Menu();
				menu.addItem((i) =>
					i
						.setTitle(revealLabel)
						.setIcon("folder")
						.setDisabled(row.missing)
						.onClick(() => void ipcRenderer.invoke("justnotes:reveal-vault", row.path)),
				);
				// A vault whose window is open stays listed until it closes.
				menu.addItem((i) =>
					i
						.setTitle("Remove from list")
						.setIcon("x")
						.setDisabled(row.open)
						.onClick(async () => {
							if (await ipcRenderer.invoke("justnotes:forget-vault", row.path)) void this.#render();
						}),
				);
				menu.showAtMouseEvent(evt);
			});
		}
	}
}
