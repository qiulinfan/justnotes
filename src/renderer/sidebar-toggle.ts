import type { App } from "../api/app";
import { setIcon } from "../api/icons";
import { type WorkspaceItem, WorkspaceSplit, WorkspaceTabs } from "../api/workspace";

// The tab group at the top right of a split: the last of side-by-side
// children, the first of stacked ones.
function topRightTabs(item: WorkspaceItem | undefined): WorkspaceTabs | null {
	if (item instanceof WorkspaceTabs) return item;
	if (!(item instanceof WorkspaceSplit) || !item.children.length) return null;
	const children = item.children as WorkspaceItem[];
	return topRightTabs(item.direction === "vertical" ? children[children.length - 1] : children[0]);
}

// Obsidian's right sidebar button (`.sidebar-toggle-button.mod-right`): at the
// right end of the right sidebar's tab header while it is open, and of the
// main area's top-right tab header while it is collapsed, so the sidebar can
// always be opened again with the mouse.
export function installRightSidebarToggle(app: App) {
	const button = createDiv("sidebar-toggle-button mod-right");
	const icon = button.createDiv("clickable-icon");
	setIcon(icon, "sidebar-right");
	icon.addEventListener("click", () => app.workspace.rightSplit.toggle());
	const place = () => {
		const right = app.workspace.rightSplit;
		icon.setAttr("aria-label", right.collapsed ? "Expand" : "Collapse");
		const tabs = topRightTabs(right.collapsed ? app.workspace.rootSplit : right);
		if (tabs && button.parentElement !== tabs.headerEl) tabs.headerEl.appendChild(button);
	};
	app.workspace.onLayoutReady(place);
	app.workspace.on("layout-change", place);
}
