import type { App } from "../api/app";
import { installBacklinksInDocument } from "./backlinks-in-document";
import { installDailyNotes } from "./daily-notes";
import { registerLinkPanes } from "./link-panes";
import { TagView } from "./tag-pane";
import { registerTemplateCommands } from "./templates";
import { installWordCount } from "./word-count";

// The sidebar panes of the core plugins justnotes implements, and their
// commands, with Obsidian's ids.
const PANES = [
	{ plugin: "backlink", type: "backlink", command: "backlink:open", name: "Backlinks: Show backlinks" },
	{ plugin: "outgoing-link", type: "outgoing-link", command: "outgoing-links:open", name: "Outgoing links: Show outgoing links" },
	{ plugin: "tag-pane", type: "tag", command: "tag-pane:open", name: "Tags view: Show tags" },
	{ plugin: "outline", type: "outline", command: "outline:open", name: "Outline: Show outline" },
];

// Views register before the layout is restored, so a saved layout gets its
// panes back whatever the vault enables.
export function registerCorePluginViews(app: App) {
	registerLinkPanes(app);
	app.viewRegistry.registerView("tag", (leaf) => new TagView(leaf));
}

// The rest follows core-plugins.json, as in Obsidian: a disabled core plugin
// adds no commands, buttons or panes.
export function installCorePlugins(app: App) {
	const enabled = (id: string) => !!app.internalPlugins.getEnabledPluginById(id);
	for (const pane of PANES) {
		if (!enabled(pane.plugin)) continue;
		app.commands.addCommand({
			id: pane.command,
			name: pane.name,
			callback: async () => app.workspace.revealLeaf(await app.workspace.ensureSideLeaf(pane.type, "right", { reveal: true })),
		});
	}
	if (enabled("backlink")) installBacklinksInDocument(app);
	if (enabled("daily-notes")) installDailyNotes(app);
	if (enabled("templates")) registerTemplateCommands(app);
	if (enabled("word-count")) installWordCount(app);
}

// The right sidebar of a vault opened for the first time: the panes the vault
// enables, as Obsidian starts it.
export function defaultRightSidebar(app: App) {
	const leaves = PANES.filter((p) => app.internalPlugins.getEnabledPluginById(p.plugin)).map((p) => ({ type: "leaf", state: { type: p.type } }));
	return { type: "split", direction: "horizontal", collapsed: true, children: leaves.length ? [{ type: "tabs", children: leaves }] : [] };
}
