import type { App } from "./app";
import { getElectron } from "./dom";
import { Notice } from "./ui/notice";

// The page's side of the updater (main/updater.ts): the "Automatic updates"
// setting, the "Check for updates" command, and the notice that offers a
// restart once a new release is ready. The setting is the app's, not the
// vault's: plain localStorage `automatic-updates`, on unless turned off.

interface UpdateState {
	status: "unsupported" | "idle" | "checking" | "downloading" | "ready" | "current" | "error";
	tag?: string;
	error?: string;
	commit: string;
}

const KEY = "automatic-updates";
const ipc = () => getElectron().ipcRenderer;

export function automaticUpdates() {
	try {
		return localStorage.getItem(KEY) !== "false";
	} catch {
		return true;
	}
}

export function setAutomaticUpdates(on: boolean) {
	localStorage.setItem(KEY, String(on));
	ipc().send("justnotes:update-auto", on);
}

export function updateState(): UpdateState {
	return ipc().sendSync("justnotes:update-state");
}

const UNSUPPORTED = "justnotes updates itself only when installed as an app, in a folder it can write; run from the repository, it updates with git.";

export async function checkForUpdates() {
	new Notice("Checking for updates…", 2000);
	const state: UpdateState = await ipc().invoke("justnotes:update-check");
	if (state.status === "unsupported") new Notice(UNSUPPORTED);
	else if (state.status === "current") new Notice("justnotes is up to date.");
	else if (state.status === "error") new Notice(`Could not update justnotes: ${state.error}`);
	// "ready" comes as its own notice (showReady).
}

let shown = "";

function showReady(state: UpdateState) {
	if (state.status !== "ready" || shown === state.tag) return;
	shown = state.tag ?? "";
	const message = createFragment((f) => {
		f.createDiv({ text: `A new justnotes (${state.tag}) is ready. It installs when justnotes quits.` });
		const button = f.createEl("button", { text: "Restart to update", cls: "mod-cta" });
		button.addEventListener("click", (evt) => {
			evt.stopPropagation();
			ipc().send("justnotes:update-restart");
		});
	});
	new Notice(message, 0);
}

export function installUpdates(app: App) {
	app.commands.addCommand({ id: "app:check-for-updates", name: "Check for updates", callback: () => void checkForUpdates() });
	ipc().on("justnotes:update-state", (_evt, state: UpdateState) => showReady(state));
	showReady(updateState());
	ipc().send("justnotes:update-auto", automaticUpdates());
}
