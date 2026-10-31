import type { App } from "../api/app";
import { LatexLive } from "../latex/latex-live";
import type { CorePluginHost, CorePluginInstaller } from "../api/internal-plugins";
import { installAudioRecorder } from "./audio-recorder";
import { installBacklinksInDocument } from "./backlinks-in-document";
import { BookmarksInstance, installBookmarks } from "./bookmarks";
import { installCanvas } from "./canvas-view";
import { registerAllPropertiesView } from "./all-properties";
import { installDailyNotes } from "./daily-notes";
import { installFileRecovery } from "./file-recovery";
import { installGraph, registerGraphViews } from "./graph-view";
import { registerLinkPanes } from "./link-panes";
import { installNoteComposer } from "./note-composer";
import { installSlides } from "./slides";
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
	{ plugin: "properties", type: "all-properties", command: "properties:open", name: "Properties view: Show all properties" },
];

// Views register before the layout is restored, so a saved layout gets its
// panes back whatever the vault enables.
export function registerCorePluginViews(app: App) {
	registerLinkPanes(app);
	app.viewRegistry.registerView("tag", (leaf) => new TagView(leaf));
	registerGraphViews(app);
	registerAllPropertiesView(app);
	const bookmarks = app.internalPlugins.plugins.bookmarks;
	bookmarks.instance = new BookmarksInstance(app);
}

// A pane's command; turned on in Settings the pane joins the right sidebar,
// turned off its leaves close.
function installPane(pane: (typeof PANES)[number]): CorePluginInstaller {
	return (app: App, host: CorePluginHost) => {
		host.addCommand({
			id: pane.command,
			name: pane.name,
			callback: async () => app.workspace.revealLeaf(await app.workspace.ensureSideLeaf(pane.type, "right", { reveal: true })),
		});
		if (host.userEnabled && !app.workspace.getLeavesOfType(pane.type).length) void app.workspace.ensureSideLeaf(pane.type, "right", { reveal: false });
		host.register(() => app.workspace.detachLeavesOfType(pane.type));
	};
}

// What each core plugin installs while enabled; the rest follows
// core-plugins.json and the Core plugins settings, as in Obsidian: a
// disabled core plugin adds no commands, buttons or panes.
function installers(): Record<string, CorePluginInstaller> {
	const result: Record<string, CorePluginInstaller> = {};
	for (const pane of PANES) result[pane.plugin] = installPane(pane);
	const backlinkPane = result.backlink;
	result.backlink = (app, host) => {
		backlinkPane(app, host);
		installBacklinksInDocument(app, host);
	};
	result.graph = installGraph;
	result.canvas = installCanvas;
	result["daily-notes"] = installDailyNotes;
	result.templates = registerTemplateCommands;
	result["note-composer"] = installNoteComposer;
	result["file-recovery"] = installFileRecovery;
	result["word-count"] = installWordCount;
	result.bookmarks = installBookmarks;
	result.slides = installSlides;
	result["audio-recorder"] = installAudioRecorder;
	result.latex = LatexLive.install;
	return result;
}

export function installCorePlugins(app: App) {
	app.internalPlugins.install(installers());
}

// The right sidebar of a vault opened for the first time: the panes the vault
// enables, as Obsidian starts it.
export function defaultRightSidebar(app: App) {
	const leaves = PANES.filter((p) => app.internalPlugins.getEnabledPluginById(p.plugin)).map((p) => ({ type: "leaf", state: { type: p.type } }));
	return { type: "split", direction: "horizontal", collapsed: true, children: leaves.length ? [{ type: "tabs", children: leaves }] : [] };
}
