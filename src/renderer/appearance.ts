// The Appearance settings that style the whole window, applied at boot and
// again whenever the vault's settings change: the base color scheme and
// accent, the fonts and font size, the body classes Obsidian's themes read
// (`show-ribbon`, `show-view-header`), and Mod+wheel font size changes. The
// zoom level is the app's, not the vault's: Chromium shares it between the
// windows of the page's origin, and localStorage `zoom-factor` keeps it.
import { webFrame } from "electron";
import type { App } from "../api/app";
import { onWindowAdded } from "../api/dom";
import { applyLineHeight } from "../api/editor-settings";
import { clampFontSize, fontFamilyList, storeZoom, ZOOM_MAX, ZOOM_MIN } from "../api/setting-options";
import { Notice } from "../api/ui/notice";

// The base theme follows "theme": "obsidian" is dark, "moonstone" light and
// "system" follows the OS. A set accentColor replaces the theme's accent.
export function installAppearance(app: App) {
	const vault = app.vault;
	const body = document.body;
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	let dark: boolean | null = null;
	let accent = "";
	let fontState = "";
	const apply = () => {
		const theme = vault.getConfig("theme");
		const next = theme === "obsidian" || (theme !== "moonstone" && media.matches);
		if (next !== dark) {
			dark = next;
			body.toggleClass("theme-dark", dark);
			body.toggleClass("theme-light", !dark);
			app.workspace.trigger("css-change");
		}
		const value = vault.getConfig("accentColor");
		const color = typeof value === "string" ? value : "";
		if (color !== accent) {
			accent = color;
			app.setAccentColor(color || null);
		}
		// Unset fonts keep the placeholder in 00-base.css, which falls through
		// to the theme's fonts.
		const families: [string, string][] = [
			["--font-interface-override", fontFamilyList(vault.getConfig("interfaceFontFamily"))],
			["--font-text-override", fontFamilyList(vault.getConfig("textFontFamily"))],
			["--font-monospace-override", fontFamilyList(vault.getConfig("monospaceFontFamily"))],
		];
		const size = Number(vault.getConfig("baseFontSize"));
		const nextFonts = JSON.stringify([families, size]);
		if (nextFonts !== fontState) {
			fontState = nextFonts;
			for (const [name, list] of families) {
				if (list) body.style.setProperty(name, list);
				else body.style.removeProperty(name);
			}
			if (Number.isFinite(size) && size > 0) body.style.setProperty("--font-text-size", `${clampFontSize(size)}px`);
			else body.style.removeProperty("--font-text-size");
			app.workspace.trigger("css-change");
		}
		body.toggleClass("show-ribbon", vault.getConfig("showRibbon") !== false);
		body.toggleClass("show-view-header", vault.getConfig("showViewHeader") !== false);
	};
	media.addEventListener("change", apply);
	vault.on("config-changed", apply);
	apply();
	applyLineHeight(app);
	vault.on("config-unreadable", (name: string) => new Notice(`${vault.configDir}/${name} could not be read; settings changes are not saved until it can.`));
	installQuickFontSize(app);
	restoreZoom();
}

// "Quick font size adjustment": Mod+wheel (a pinch on a trackpad arrives as
// Ctrl+wheel) changes the font size by a pixel per step, unless a view that
// zooms itself (canvas, graph) took the wheel.
function installQuickFontSize(app: App) {
	let pending = 0;
	const onWheel = (evt: WheelEvent) => {
		if (evt.defaultPrevented || !(evt.ctrlKey || evt.metaKey) || app.vault.getConfig("baseFontSizeAction") === false) return;
		evt.preventDefault();
		// Trackpads send many small deltas; a step is 50 pixels of scroll.
		pending += evt.deltaY;
		const steps = Math.trunc(pending / 50);
		if (!steps) return;
		pending -= steps * 50;
		const size = Number(app.vault.getConfig("baseFontSize")) || 16;
		app.vault.setConfig("baseFontSize", clampFontSize(size - steps));
	};
	const install = (win: Window) => win.addEventListener("wheel", onWheel, { passive: false });
	install(window);
	onWindowAdded(install);
}

// The saved zoom applies at boot; a zoom from the View menu (or a shortcut)
// changes the window's size in CSS pixels, so a resize records it.
function restoreZoom() {
	const saved = Number(localStorage.getItem("zoom-factor"));
	if (Number.isFinite(saved) && saved >= ZOOM_MIN && saved <= ZOOM_MAX && saved !== webFrame.getZoomFactor()) webFrame.setZoomFactor(saved);
	let last = webFrame.getZoomFactor();
	window.addEventListener("resize", () => {
		const now = webFrame.getZoomFactor();
		if (now === last) return;
		last = now;
		storeZoom(now);
	});
}
