import type { App } from "./app";
import { setIcon } from "./icons";
import type { Hotkey } from "./keymap";
import { type PluginManifest, SettingTab } from "./plugin";
import { Modal } from "./ui/modal";
import { SearchComponent, Setting, SettingGroup, type SettingPage } from "./ui/setting";
import { findPage, openDefinitionPage, refreshTab, renderTab, searchDefinitions, tabUpdated, teardownTab } from "./ui/setting-definitions";
import { Platform } from "./util";

export interface SettingPageEntry {
	page: SettingPage;
	// Where the tab or page below was scrolled to; closing this page returns there.
	scrollTop: number;
}

// app.setting: the settings window. Its core tabs come first, then one tab per
// community plugin; a tab can push sub-pages (Obsidian 1.13), and Escape steps
// back out of a page before it closes the window.
export class SettingModal extends Modal {
	settingTabs: SettingTab[];
	pluginTabs: SettingTab[] = [];
	activeTab: SettingTab | null = null;
	lastTabId = "";
	pageStack: SettingPageEntry[] = [];
	tabHeadersEl: HTMLElement;
	tabContentContainer: HTMLElement;
	backButtonEl: HTMLElement;
	titleTextEl: HTMLElement;
	searchComponent: SearchComponent;
	searchResultsEl: HTMLElement;
	#groupsEl: HTMLElement;

	constructor(app: App) {
		super(app);
		this.modalEl.addClass("mod-settings", "mod-sidebar-layout");
		this.contentEl.addClass("vertical-tabs-container");
		// The header (hidden on desktop) mirrors the current tab or page title.
		this.backButtonEl = this.titleEl.createDiv("clickable-icon modal-setting-back-button mod-raised");
		setIcon(this.backButtonEl, "arrow-left");
		this.backButtonEl.addEventListener("click", () => this.closePage());
		this.titleTextEl = this.titleEl.createDiv();
		this.tabHeadersEl = this.contentEl.createDiv({ cls: "vertical-tab-header", attr: { tabindex: "-1" } });
		this.searchComponent = new SearchComponent(this.tabHeadersEl.createDiv("setting-search-container"))
			.setPlaceholder("Search settings...")
			.onChange((query) => this.#renderSearch(query));
		this.searchComponent.containerEl.addClass("mod-raised");
		this.searchResultsEl = this.tabHeadersEl.createDiv("setting-search-results");
		this.searchResultsEl.hide();
		this.#groupsEl = this.tabHeadersEl.createDiv("vertical-tab-header-group-container");
		this.tabContentContainer = this.contentEl.createDiv("vertical-tab-content-container");
		this.settingTabs = [new HotkeysTab(app), new CommunityPluginsTab(app)];
		const escape = this.scope.keys.find((h) => h.key === "Escape");
		if (escape) this.scope.unregister(escape);
		this.scope.register([], "Escape", () => {
			if (this.pageStack.length) this.closePage();
			else this.close();
			return false;
		});
	}

	addSettingTab(tab: SettingTab) {
		this.pluginTabs.push(tab);
		// Obsidian reads the definitions once here, for search.
		this.#update(tab);
		if (this.isOpen) this.#renderNav();
	}

	removeSettingTab(tab: SettingTab) {
		this.pluginTabs.remove(tab);
		if (this.activeTab === tab) {
			this.clearPageStack();
			this.#hideTab(tab);
			tab.containerEl.detach();
			this.activeTab = null;
			if (this.isOpen) this.openTab(this.settingTabs[0] ?? null);
		}
		if (this.isOpen) this.#renderNav();
	}

	// SettingTab.update() lands here: redraws whatever of the tab is on screen.
	redrawTab(tab: SettingTab) {
		tabUpdated(tab);
	}

	// SettingTab.refreshDomState() lands here.
	refreshTabDomState(tab: SettingTab) {
		refreshTab(tab);
	}

	onOpen() {
		this.#renderNav();
		this.openTab(this.activeTab ?? this.#find(this.lastTabId) ?? this.settingTabs[0] ?? null);
	}

	onClose() {
		this.clearPageStack();
		if (this.activeTab) this.#hideTab(this.activeTab);
		this.searchComponent.setValue("");
		this.#renderSearch("");
	}

	openTab(tab: SettingTab | null) {
		this.clearPageStack();
		if (this.activeTab) this.#hideTab(this.activeTab);
		this.tabContentContainer.empty();
		this.activeTab = tab;
		this.#markActive();
		if (tab) {
			this.lastTabId = tab.id;
			this.tabContentContainer.appendChild(tab.containerEl);
			this.#display(tab);
		}
		this.tabContentContainer.scrollTop = 0;
		this.#syncTitle();
	}

	openTabById(id: string) {
		const tab = this.#find(id);
		if (!this.isOpen) {
			this.activeTab = tab;
			this.open();
		} else this.openTab(tab);
		return tab;
	}

	// Shows a sub-page over the current tab or page. The page below stays
	// rendered; the tab itself is hidden and redrawn when the last page closes.
	openPage(page: SettingPage) {
		const below = this.pageStack.last();
		this.pageStack.push({ page, scrollTop: this.tabContentContainer.scrollTop });
		try {
			page.display();
		} catch (err) {
			console.error("Settings page failed", err);
		}
		page.titlebarEl.empty();
		const back = page.titlebarEl.createDiv("clickable-icon setting-page-back-button");
		setIcon(back, "chevron-left");
		back.addEventListener("click", () => this.closePage());
		page.titlebarEl.createDiv({ cls: "setting-page-title", text: page.title });
		if (below) below.page.rootEl.detach();
		else if (this.activeTab) {
			this.#hideTab(this.activeTab);
			this.activeTab.containerEl.detach();
		}
		this.tabContentContainer.appendChild(page.rootEl);
		this.tabContentContainer.scrollTop = 0;
		this.#syncTitle();
	}

	closePage() {
		const entry = this.pageStack.pop();
		if (!entry) return;
		this.#hidePage(entry.page);
		const top = this.pageStack.last();
		if (top) {
			this.tabContentContainer.appendChild(top.page.rootEl);
			try {
				top.page.display();
			} catch (err) {
				console.error("Settings page failed", err);
			}
		} else if (this.activeTab) {
			this.tabContentContainer.appendChild(this.activeTab.containerEl);
			this.#display(this.activeTab);
		}
		this.#scrollTo(entry.scrollTop);
		this.#syncTitle();
	}

	// Hides every page, top first, without showing the tab again.
	clearPageStack() {
		let entry: SettingPageEntry | undefined;
		while ((entry = this.pageStack.pop())) this.#hidePage(entry.page);
	}

	updatePageTitle() {
		this.#syncTitle();
	}

	// Opens a tab, then the declarative pages named by pagePath.
	navigateToSearchResult(result: { tab: SettingTab; pagePath?: string[] }, _evt?: unknown) {
		const { tab, pagePath = [] } = result;
		if (!this.isOpen) {
			this.activeTab = tab;
			this.open();
		} else this.openTab(tab);
		for (let i = 1; i <= pagePath.length; i++) {
			const path = pagePath.slice(0, i);
			const def = findPage(tab.settingItems, path);
			if (!def) break;
			openDefinitionPage(tab, def, path);
		}
	}

	#find(id: string) {
		return this.settingTabs.find((t) => t.id === id) ?? this.pluginTabs.find((t) => t.id === id) ?? null;
	}

	#update(tab: SettingTab) {
		try {
			tab.update();
		} catch (err) {
			console.error(`Settings tab ${tab.id} failed to list its settings`, err);
		}
	}

	// An imperative tab's container is its own, as in Obsidian: display()
	// clears it if it redraws, and some tabs (terminal) build their settings
	// once at load and only refresh them in display().
	#display(tab: SettingTab) {
		this.#update(tab);
		try {
			if (tab.settingItems.length) renderTab(tab);
			else tab.display();
		} catch (err) {
			console.error(`Settings tab ${tab.id} failed`, err);
		}
	}

	// The window takes a definitions-rendered tab down itself, so the render
	// cleanups run even when a plugin's hide() does not call super.hide().
	#hideTab(tab: SettingTab) {
		try {
			tab.hide();
		} catch (err) {
			console.error(`Settings tab ${tab.id} failed to hide`, err);
		}
		teardownTab(tab);
	}

	#hidePage(page: SettingPage) {
		try {
			page.hide();
		} catch (err) {
			console.error("Settings page failed to hide", err);
		}
		page.rootEl.detach();
	}

	// A tab or page that finishes drawing a moment later would clamp the
	// position now, so it is set again on the next frame if it fell short.
	#scrollTo(top: number) {
		const container = this.tabContentContainer;
		container.scrollTop = top;
		if (container.scrollTop < top) requestAnimationFrame(() => (container.scrollTop = top));
	}

	#syncTitle() {
		const top = this.pageStack.last();
		this.titleTextEl.setText(top ? top.page.title : (this.activeTab?.name ?? ""));
		this.backButtonEl.toggle(!!top);
	}

	#renderNav() {
		this.#groupsEl.empty();
		this.#navGroup("Options", "options", this.settingTabs);
		this.#navGroup("Community plugins", "community-plugins", [...this.pluginTabs].sort((a, b) => a.name.localeCompare(b.name)));
	}

	#navGroup(title: string, section: string, tabs: SettingTab[]) {
		const group = this.#groupsEl.createDiv("vertical-tab-header-group");
		group.createDiv({ cls: "vertical-tab-header-group-title", text: title });
		const items = group.createDiv({ cls: "vertical-tab-header-group-items", attr: { "data-section": section } });
		for (const tab of tabs) {
			const item = items.createDiv({ cls: "vertical-tab-nav-item tappable", attr: { tabindex: "-1", "data-setting-id": tab.id } });
			if (tab.icon) setIcon(item.createDiv("vertical-tab-nav-item-icon"), tab.icon);
			item.createDiv({ cls: "vertical-tab-nav-item-title", text: tab.name });
			setIcon(item.createDiv("vertical-tab-nav-item-chevron"), "chevron-right");
			item.toggleClass("is-active", tab === this.activeTab);
			item.addEventListener("click", () => this.openTab(tab));
		}
	}

	#markActive() {
		for (const item of this.#groupsEl.findAll(".vertical-tab-nav-item")) {
			item.toggleClass("is-active", item.getAttr("data-setting-id") === this.activeTab?.id);
		}
	}

	#renderSearch(query: string) {
		const q = query.trim();
		this.searchResultsEl.empty();
		this.searchResultsEl.toggle(q !== "");
		this.#groupsEl.toggle(q === "");
		if (!q) return;
		let found = 0;
		for (const tab of [...this.settingTabs, ...this.pluginTabs]) {
			const matches = searchDefinitions(tab.settingItems, q);
			if (tab.name.toLowerCase().includes(q.toLowerCase())) matches.unshift({ name: tab.name, pagePath: [] });
			for (const match of matches) {
				found++;
				const item = this.searchResultsEl.createDiv({ cls: "setting-search-result tappable", attr: { tabindex: "-1" } });
				item.createDiv({ cls: "setting-search-result-name", text: match.name });
				item.createDiv({ cls: "setting-search-result-path", text: [tab.name, ...match.pagePath].join(" › ") });
				item.addEventListener("click", () => {
					this.navigateToSearchResult({ tab, pagePath: match.pagePath });
					this.#reveal(match.name);
				});
			}
		}
		if (!found) this.searchResultsEl.createDiv({ cls: "setting-search-empty", text: "No settings found." });
	}

	// Scrolls the setting with this name into view in the visible content.
	#reveal(name: string) {
		const names = this.tabContentContainer.findAll(".setting-item-name");
		names.find((el) => el.getText() === name)?.scrollIntoView({ block: "center" });
	}
}

type Manifest = PluginManifest & { fundingUrl?: string | Record<string, string> };

class CommunityPluginsTab extends SettingTab {
	installedPlugins: SettingGroup | null = null;
	#query = "";

	constructor(app: App) {
		super(app);
		this.id = "community-plugins";
		this.name = "Community plugins";
		this.icon = "puzzle";
	}

	display() {
		this.containerEl.empty();
		const group = new SettingGroup(this.containerEl).setHeading("Installed plugins").addClass("mod-list", "mod-no-icon");
		this.installedPlugins = group;
		const rows: [string, HTMLElement][] = [];
		const filter = () => {
			const q = this.#query.trim().toLowerCase();
			for (const [name, el] of rows) el.toggle(!q || name.includes(q));
		};
		group.addSearch((s) =>
			s
				.setPlaceholder("Search installed plugins...")
				.setValue(this.#query)
				.onChange((q) => {
					this.#query = q;
					filter();
				}),
		);
		const manifests = Object.values(this.app.plugins.manifests).sort((a, b) => a.name.localeCompare(b.name));
		if (!manifests.length) new Setting(group.listEl).setName("No community plugins are installed in this vault.").settingEl.addClass("mod-empty-state");
		for (const manifest of manifests) {
			this.renderInstalledPlugin(manifest, group.listEl);
			rows.push([manifest.name.toLowerCase(), group.listEl.lastElementChild as HTMLElement]);
		}
		filter();
	}

	renderInstalledPlugin(manifest: Manifest, containerEl: HTMLElement) {
		const plugins = this.app.plugins;
		const setting = new Setting(containerEl);
		setting.settingEl.setAttr("data-plugin-id", manifest.id);
		setting.settingEl.insertBefore(createDiv("setting-item-icon"), setting.infoEl);
		// The name stands alone: terminal finds its row by the name's text to
		// click the row's donate button.
		setting.setName(manifest.name);
		const about = setting.descEl.createDiv();
		about.createSpan({ cls: "u-numeric", text: `v${manifest.version}` });
		if (manifest.author) about.appendText(` By ${manifest.author}`);
		if (manifest.description) setting.descEl.createDiv({ text: manifest.description });
		const funding = typeof manifest.fundingUrl === "string" ? manifest.fundingUrl : Object.values(manifest.fundingUrl ?? {})[0];
		if (funding) setting.addExtraButton((b) => b.setIcon("heart").setTooltip("Donate").onClick(() => window.open(funding)));
		const enabled = plugins.enabledPlugins.has(manifest.id);
		const tab = this.app.setting.pluginTabs.find((t) => t.id === manifest.id);
		if (enabled && tab) setting.addExtraButton((b) => b.setIcon("settings").setTooltip("Options").onClick(() => this.app.setting.openTab(tab)));
		// The choice persists in justnotes' own list, never in community-plugins.json.
		setting.addToggle((toggle) =>
			toggle.setValue(enabled).onChange(async (on) => {
				toggle.setDisabled(true);
				await (on ? plugins.enablePluginAndSave(manifest.id) : plugins.disablePluginAndSave(manifest.id));
				if (this.containerEl.isConnected) this.display();
			}),
		);
	}
}

// Read-only for now: bindings come from hotkeys.json and plugin defaults.
class HotkeysTab extends SettingTab {
	#query = "";

	constructor(app: App) {
		super(app);
		this.id = "hotkeys";
		this.name = "Hotkeys";
		this.icon = "command";
	}

	display() {
		this.containerEl.empty();
		const group = new SettingGroup(this.containerEl).addClass("mod-list", "mod-hotkeys");
		const rows: [string, HTMLElement][] = [];
		const filter = () => {
			const q = this.#query.trim().toLowerCase();
			for (const [text, el] of rows) el.toggle(!q || text.includes(q));
		};
		group.addSearch((s) =>
			s
				.setPlaceholder("Filter...")
				.setValue(this.#query)
				.onChange((q) => {
					this.#query = q;
					filter();
				}),
		);
		const keys = this.app.hotkeyManager;
		const commands = this.app.commands.listCommands().sort((a, b) => a.name.localeCompare(b.name));
		for (const command of commands) {
			const setting = new Setting(group.listEl).setName(command.name);
			const list = setting.controlEl.createDiv("setting-command-hotkeys");
			const hotkeys = keys.getHotkeys(command.id) ?? keys.getDefaultHotkeys(command.id) ?? [];
			const printed = hotkeys.map(formatHotkey);
			if (!printed.length) list.createSpan({ cls: "setting-hotkey mod-empty", text: "Blank" });
			for (const text of printed) list.createSpan({ cls: "setting-hotkey", text });
			rows.push([`${command.name} ${printed.join(" ")}`.toLowerCase(), setting.settingEl]);
		}
		filter();
	}
}

function formatHotkey(hotkey: Hotkey) {
	const glyph: Record<string, string> = Platform.isMacOS
		? { Mod: "⌘", Meta: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥" }
		: { Mod: "Ctrl", Meta: "Win", Ctrl: "Ctrl", Shift: "Shift", Alt: "Alt" };
	const key = hotkey.key === " " ? "Space" : hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;
	return [...(hotkey.modifiers ?? []).map((m) => glyph[m] ?? m), key].join(Platform.isMacOS ? " " : "+");
}
