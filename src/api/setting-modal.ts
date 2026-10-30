import type { App } from "./app";
import type { SettingTab } from "./plugin";
import { Modal } from "./ui/modal";

export class SettingModal extends Modal {
	pluginTabs: SettingTab[] = [];
	activeTab: SettingTab | null = null;
	#navEl: HTMLElement;
	#contentEl: HTMLElement;

	constructor(app: App) {
		super(app);
		this.modalEl.addClass("mod-settings");
		const container = this.contentEl.createDiv("vertical-tabs-container");
		this.#navEl = container.createDiv("vertical-tab-header");
		this.#contentEl = container.createDiv("vertical-tab-content-container");
	}

	addSettingTab(tab: SettingTab) {
		this.pluginTabs.push(tab);
		if (this.isOpen) this.#renderNav();
	}

	removeSettingTab(tab: SettingTab) {
		this.pluginTabs.remove(tab);
		if (this.activeTab === tab) this.activeTab = null;
		if (this.isOpen) this.#renderNav();
	}

	onOpen() {
		this.#renderNav();
		this.openTab(this.activeTab ?? this.pluginTabs[0] ?? null);
	}

	onClose() {
		this.activeTab?.hide();
	}

	#renderNav() {
		this.#navEl.empty();
		this.#navEl.createDiv({ cls: "vertical-tab-header-group-title", text: "Community plugins" });
		const items = this.#navEl.createDiv("vertical-tab-header-group-items");
		for (const tab of [...this.pluginTabs].sort((a, b) => a.name.localeCompare(b.name))) {
			const item = items.createDiv({ cls: "vertical-tab-nav-item", text: tab.name });
			item.toggleClass("is-active", tab === this.activeTab);
			item.addEventListener("click", () => this.openTab(tab));
		}
	}

	openTab(tab: SettingTab | null) {
		this.activeTab?.hide();
		this.#contentEl.empty();
		this.activeTab = tab;
		this.#renderNav();
		if (!tab) return;
		this.#contentEl.appendChild(tab.containerEl);
		tab.containerEl.empty();
		try {
			tab.display();
		} catch (err) {
			console.error(`Settings tab ${tab.id} failed`, err);
		}
	}

	openTabById(id: string) {
		const tab = this.pluginTabs.find((t) => t.id === id) ?? null;
		if (!this.isOpen) {
			this.activeTab = tab;
			this.open();
		} else this.openTab(tab);
		return tab;
	}
}
