import * as os from "node:os";
import * as path from "node:path";
import { ipcRenderer } from "electron";
import type { VaultResult, VaultRow } from "../main/vault-switcher";

// The vault picker's page (main/vault-picker.ts): the known vaults, Open
// folder… and New vault…, through the vault switcher's IPC in main
// (main/vault-switcher.ts), which owns vaults.json and opens the windows. The
// picker closes once a vault opens. Keys: ↑ ↓ choose, Enter opens, typing
// searches, Esc clears the search or leaves the new-vault form, Cmd/Ctrl+O and
// Cmd/Ctrl+N stand for the two buttons.

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const search = $<HTMLInputElement>(".picker-search");
const list = $<HTMLUListElement>(".picker-list");
const empty = $<HTMLParagraphElement>(".picker-empty");
const form = $<HTMLFormElement>(".picker-new");
const nameInput = $<HTMLInputElement>(".picker-name");
const locationButton = $<HTMLButtonElement>(".picker-location");
const errorText = $<HTMLParagraphElement>(".picker-error");

const REVEAL = process.platform === "darwin" ? "Reveal in Finder" : process.platform === "win32" ? "Show in Explorer" : "Show in folder";
// Lucide's folder and x, drawn like the app's other icons.
const ICONS = {
	reveal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
	remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};
// More vaults than this get a search field.
const SEARCH_FROM = 6;

let rows: VaultRow[] = [];
let shown: VaultRow[] = [];
let selected = 0;
let location = os.homedir();

const opened = (result: VaultResult) => {
	if (result && "vault" in result) window.close();
	return result;
};

async function load() {
	rows = await ipcRenderer.invoke("justnotes:vaults");
	search.hidden = rows.length < SEARCH_FROM;
	// A new vault goes beside the existing ones by default.
	const existing = rows.find((row) => !row.missing);
	if (existing) location = path.dirname(existing.path);
	render();
}

function render() {
	const query = search.value.trim().toLowerCase();
	shown = query ? rows.filter((row) => row.label.toLowerCase().includes(query) || row.shortPath.toLowerCase().includes(query)) : rows;
	selected = Math.min(selected, Math.max(0, shown.length - 1));
	list.replaceChildren(...shown.map(rowElement));
	empty.hidden = rows.length > 0 || !form.hidden;
	list.hidden = !form.hidden;
}

function rowElement(row: VaultRow, index: number) {
	const li = document.createElement("li");
	li.className = "picker-row";
	li.setAttribute("role", "option");
	li.classList.toggle("is-selected", index === selected);
	li.classList.toggle("is-missing", row.missing);
	li.setAttribute("aria-selected", String(index === selected));
	li.title = row.missing ? `${row.path} is gone` : row.path;
	const text = li.appendChild(document.createElement("div"));
	text.className = "picker-row-text";
	const name = text.appendChild(document.createElement("div"));
	name.className = "picker-row-name";
	name.textContent = row.label;
	const where = text.appendChild(document.createElement("div"));
	where.className = "picker-row-path";
	where.textContent = row.missing ? `Folder not found · ${row.shortPath}` : row.shortPath;
	if (row.open) {
		const badge = li.appendChild(document.createElement("span"));
		badge.className = "picker-row-badge";
		badge.textContent = "Open";
	}
	const actions = li.appendChild(document.createElement("div"));
	actions.className = "picker-row-actions";
	if (!row.missing) actions.appendChild(iconButton(ICONS.reveal, REVEAL, () => ipcRenderer.invoke("justnotes:reveal-vault", row.path)));
	if (!row.open) {
		actions.appendChild(
			iconButton(ICONS.remove, "Remove from list (the folder stays)", async () => {
				if (await ipcRenderer.invoke("justnotes:forget-vault", row.path)) await load();
			}),
		);
	}
	li.addEventListener("mouseenter", () => select(index));
	li.addEventListener("click", () => void openRow(row));
	return li;
}

function iconButton(svg: string, label: string, action: () => unknown) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "picker-icon-button";
	button.title = label;
	button.setAttribute("aria-label", label);
	button.innerHTML = svg;
	button.addEventListener("click", (evt) => {
		evt.stopPropagation();
		void action();
	});
	return button;
}

function select(index: number) {
	if (index === selected || index < 0 || index >= shown.length) return;
	list.children[selected]?.classList.remove("is-selected");
	selected = index;
	const li = list.children[selected];
	li?.classList.add("is-selected");
	li?.scrollIntoView({ block: "nearest" });
}

async function openRow(row: VaultRow | undefined) {
	if (!row || row.missing) return;
	if (await ipcRenderer.invoke("justnotes:switch-vault", row.path)) window.close();
}

async function openFolder() {
	const result = opened(await ipcRenderer.invoke("justnotes:open-folder-as-vault"));
	if (result && "error" in result) alert(result.error);
}

function showForm(show: boolean) {
	form.hidden = !show;
	document.body.classList.toggle("is-creating", show);
	errorText.textContent = "";
	locationButton.textContent = location.replace(os.homedir(), "~");
	render();
	if (show) {
		nameInput.value = "";
		nameInput.focus();
	} else (search.hidden ? list : search).focus();
}

async function create() {
	const result = opened(await ipcRenderer.invoke("justnotes:create-vault", location, nameInput.value));
	if (result && "error" in result) errorText.textContent = result.error;
}

search.addEventListener("input", () => {
	selected = 0;
	render();
});
$(".picker-open").addEventListener("click", () => void openFolder());
$(".picker-new-button").addEventListener("click", () => showForm(true));
$(".picker-cancel").addEventListener("click", () => showForm(false));
locationButton.addEventListener("click", async () => {
	const picked: string | null = await ipcRenderer.invoke("justnotes:pick-vault-location");
	if (!picked) return;
	location = picked;
	locationButton.textContent = location.replace(os.homedir(), "~");
});
form.addEventListener("submit", (evt) => {
	evt.preventDefault();
	void create();
});
nameInput.addEventListener("input", () => (errorText.textContent = ""));
// Enter creates, except while an input method is still composing the name.
nameInput.addEventListener("keydown", (evt) => {
	if (evt.key !== "Enter" || evt.isComposing || evt.keyCode === 229) return;
	evt.preventDefault();
	void create();
});

document.addEventListener("keydown", (evt) => {
	const mod = process.platform === "darwin" ? evt.metaKey : evt.ctrlKey;
	if (mod && evt.key.toLowerCase() === "o") return void (evt.preventDefault(), openFolder());
	if (mod && evt.key.toLowerCase() === "n") return void (evt.preventDefault(), showForm(true));
	if (!form.hidden) {
		if (evt.key === "Escape") showForm(false);
		return;
	}
	if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
		evt.preventDefault();
		select(selected + (evt.key === "ArrowDown" ? 1 : -1));
	} else if (evt.key === "Enter") {
		evt.preventDefault();
		void openRow(shown[selected]);
	} else if (evt.key === "Escape" && search.value) {
		search.value = "";
		render();
	} else if (!search.hidden && evt.key.length === 1 && !mod && document.activeElement !== search) {
		search.focus();
	}
});

void load();
