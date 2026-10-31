import { describe, expect, test } from "bun:test";
import { terminalAppearance, type ThemeColors } from "../src/renderer/terminal/appearance";
import { ghosttyConfigFiles, readGhosttyConfig } from "../src/renderer/terminal/ghostty-config";

const HOME = "/home/u";
const THEME: ThemeColors = { background: "#101010", foreground: "#e0e0e0", selection: "#334455", cursor: "#aa88ff" };

function configOf(files: Record<string, string>, order = Object.keys(files).slice(0, 1)) {
	return readGhosttyConfig(order, (path) => files[path] ?? null, HOME);
}

describe("Ghostty's config files", () => {
	test("macOS reads the XDG files, then Application Support, each as config and config.ghostty", () => {
		expect(ghosttyConfigFiles(HOME, {}, "darwin")).toEqual([
			"/home/u/.config/ghostty/config",
			"/home/u/.config/ghostty/config.ghostty",
			"/home/u/Library/Application Support/com.mitchellh.ghostty/config",
			"/home/u/Library/Application Support/com.mitchellh.ghostty/config.ghostty",
		]);
		expect(ghosttyConfigFiles(HOME, { XDG_CONFIG_HOME: "/x" }, "linux")).toEqual(["/x/ghostty/config", "/x/ghostty/config.ghostty"]);
	});

	test("no file at all is no config", () => {
		expect(configOf({}, ["/a/config"])).toBeNull();
	});

	// The owner's layout: the main file names an include at its end, which
	// clears the font list and sets everything again.
	test("an included file loads after the file naming it and wins; empty values reset", () => {
		const config = configOf({
			"/cfg/config.ghostty": [
				"# comment",
				"font-family = Old Font",
				"font-size = 12",
				"background = #000000",
				'config-file = "inc/extra.ghostty"',
				"background-image = ~/Pictures/a.jpg",
				"font-feature = -calt",
				"cursor-color = #ffffff",
				"cursor-color =",
			].join("\n"),
			"/cfg/inc/extra.ghostty": ['font-family = ""', "font-family = JetBrainsMono Nerd Font Mono", "font-family = Symbols Nerd Font", "font-size = 14", "palette = 1=#bf616a", "palette = 14=8fbcbb", "font-feature =", "font-feature = -calt,-liga", "background-image = img/b.png", "config-file = ?missing", "config-file = ../config.ghostty"].join("\n"),
		})!;
		expect(config.fontFamily).toEqual(["JetBrainsMono Nerd Font Mono", "Symbols Nerd Font"]);
		expect(config.values.get("font-size")).toBe("14");
		expect(config.values.get("background")).toBe("#000000");
		// Relative to the file that sets it.
		expect(config.values.get("background-image")).toBe("/cfg/inc/img/b.png");
		expect(config.values.has("cursor-color")).toBe(false);
		expect(config.fontFeature).toEqual(["-calt", "-liga"]);
		expect([...config.palette]).toEqual([
			[1, "#bf616a"],
			[14, "8fbcbb"],
		]);
		// The include cycle back to the first file is not followed again.
		expect(config.files).toEqual(["/cfg/config.ghostty", "/cfg/inc/extra.ghostty"]);
	});

	test("~ paths are the home folder's", () => {
		const config = configOf({ "/c/config": "background-image = ~/w.jpg" })!;
		expect(config.values.get("background-image")).toBe("/home/u/w.jpg");
	});
});

describe("Ghostty's config as the terminal's look", () => {
	const owner = configOf({
		"/c/config": [
			"font-family = JetBrainsMono Nerd Font Mono",
			"font-style = SemiBold",
			"font-style-bold = Bold",
			"font-size = 14",
			"font-feature = -calt,-liga,-dlig",
			"adjust-cell-height = -10%",
			"background = #2e3440",
			"foreground = d8dee9",
			"bold-color = #ffffff",
			"selection-background = #eceff4",
			"selection-foreground = #4c566a",
			"palette = 0=#3b4252",
			"palette = 15=#eceff4",
			"palette = 17=#00005f",
			"background-image = /w/miku.jpg",
			"background-image-opacity = 0.15",
			"background-image-fit = cover",
			"background-image-position = top-right",
			"background-image-repeat = false",
			"background-opacity = 0.9",
			"cursor-style = bar",
			"cursor-style-blink = false",
			"cursor-color = #eceff4",
			"cursor-text = #282828",
			"macos-option-as-alt = false",
		].join("\n"),
	});

	test("fonts, colours, cursor and palette map to xterm options", () => {
		const { options } = terminalAppearance(owner, THEME);
		expect(options.fontFamily?.startsWith('"JetBrainsMono Nerd Font Mono", "JetBrains Mono"')).toBe(true);
		expect(options.fontFamily?.endsWith("monospace")).toBe(true);
		expect([options.fontSize, options.fontWeight, options.fontWeightBold]).toEqual([14, 600, 700]);
		// xterm refuses a line height under 1.
		expect(options.lineHeight).toBe(1);
		expect(options.theme).toMatchObject({
			background: "#00000000",
			foreground: "#d8dee9",
			selectionBackground: "#eceff4",
			selectionForeground: "#4c566a",
			cursor: "#eceff4",
			cursorAccent: "#282828",
			black: "#3b4252",
			brightWhite: "#eceff4",
		});
		expect(options.theme.extendedAnsi?.[1]).toBe("#00005f");
		expect([options.cursorStyle, options.cursorBlink, options.drawBoldTextInBrightColors, options.macOptionIsMeta]).toEqual(["bar", false, false, false]);
	});

	test("the background colour, its opacity and the image go to the backdrop", () => {
		const look = terminalAppearance(owner, THEME);
		expect(look.backdrop).toEqual({
			color: "#2e3440",
			opacity: 0.9,
			image: { path: "/w/miku.jpg", opacity: 0.15, size: "cover", position: "right top", repeat: "no-repeat" },
		});
		expect(look.fontFeatureSettings).toBe('"calt" 0, "liga" 0, "dlig" 0');
	});

	test("a font size from the settings wins; a positive cell height grows the line", () => {
		const config = configOf({ "/c/config": "font-size = 14\nadjust-cell-height = 20%\nbackground-image-fit = stretch\nbackground-image = /i.png" });
		const look = terminalAppearance(config, THEME, { fontSize: 18 });
		expect([look.options.fontSize, look.options.lineHeight, look.backdrop.image?.size]).toEqual([18, 1.2, "100% 100%"]);
	});

	// Turning "Use Ghostty's config" off must not leave its weights or bold
	// colours on the open terminals.
	test("without a config the theme's colours apply and every option is back at xterm's default", () => {
		const look = terminalAppearance(null, THEME);
		expect(look.options.theme).toMatchObject({ foreground: "#e0e0e0", cursor: "#aa88ff", selectionBackground: "#334455", cursorAccent: "#101010" });
		expect(look.options.theme.black).toBeUndefined();
		expect([look.options.fontWeight, look.options.fontWeightBold, look.options.drawBoldTextInBrightColors, look.options.lineHeight, look.options.fontSize]).toEqual(["normal", "bold", true, 1, 13]);
		expect(look.backdrop).toEqual({ color: "#101010", opacity: 1, image: null });
	});
});
