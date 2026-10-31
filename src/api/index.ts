// The `obsidian` module plugins require.
export * from "./app";
export * from "./editor";
export * from "./events";
export * from "./file-manager";
export * from "./icons";
export * from "./keymap";
export * from "./markdown";
export * from "./markdown-preview";
export * from "./markdown-view";
export * from "./metadata";
export * from "./metadata-utils";
export * from "./plugin";
export * from "./sanitize";
export * from "./secret-storage";
export * from "./ui/menu";
export * from "./ui/modal";
export * from "./ui/notice";
export * from "./ui/popover";
export * from "./ui/setting";
export * from "./ui/suggest";
export { displayTooltip, type TooltipPlacement } from "./ui/tooltip";
export * from "./util";
export * from "./vault";
export * from "./view";
export * from "./workspace";

import { apiVersion } from "./util";

export function requireApiVersion(version: string) {
	const have = apiVersion.split(".").map(Number);
	const want = version.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
	}
	return true;
}
