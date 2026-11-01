import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import type { GhosttyConfig } from "./ghostty-config";

// How a terminal looks: xterm.js options plus what is drawn around its
// (transparent) canvas: the backdrop (Ghostty's background colour at
// `background-opacity` over the pane, with the background image on it), the
// padding and the font features. Made from Ghostty's config when there is
// one, else from the app theme's colours.
export interface TerminalAppearance {
	options: ITerminalOptions & { theme: ITheme };
	backdrop: Backdrop;
	padding: { top: number; right: number; bottom: number; left: number };
	// CSS font-feature-settings for the DOM renderer ("" for none); the WebGL
	// renderer draws cell by cell and never joins ligatures.
	fontFeatureSettings: string;
}

export interface Backdrop {
	color: string;
	opacity: number;
	image: BackdropImage | null;
}

export interface BackdropImage {
	path: string;
	opacity: number;
	size: string;
	position: string;
	repeat: string;
}

// The app theme's colours, read from the page's CSS variables.
export interface ThemeColors {
	background: string;
	foreground: string;
	selection: string;
	cursor: string;
}

export interface AppearanceOverrides {
	fontSize?: number | null;
	// False: no backdrop, so the pane behind the terminal shows.
	background?: boolean;
}

// Fonts tried after the configured ones (a configured font that is not
// installed falls through to these), then the generic monospace.
const FALLBACK_FONTS = ["JetBrains Mono", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Courier New", "monospace"];
const DEFAULT_FONT_SIZE = 13;

const ANSI_NAMES = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
] as const;

export function fontFamilyCss(families: string[]) {
	const seen = new Set<string>();
	const list: string[] = [];
	for (const family of [...families, ...FALLBACK_FONTS]) {
		const name = family.trim();
		if (!name || seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		list.push(name === "monospace" ? name : `"${name.replace(/"/g, "")}"`);
	}
	return list.join(", ");
}

// A Ghostty font style name ("SemiBold Italic") as a CSS weight.
export function fontWeight(style: string | undefined): number | null {
	if (!style || style === "false" || style === "default") return null;
	const s = style.toLowerCase().replace(/[\s_-]/g, "");
	const weights: [RegExp, number][] = [
		[/thin|hairline/, 100],
		[/(extra|ultra)light/, 200],
		[/semibold|demibold/, 600],
		[/(extra|ultra)bold/, 800],
		[/black|heavy/, 900],
		[/light/, 300],
		[/medium/, 500],
		[/bold/, 700],
		[/regular|normal|book|italic|oblique/, 400],
	];
	for (const [re, weight] of weights) if (re.test(s)) return weight;
	return null;
}

// A Ghostty colour as CSS: `#rrggbb`, `rrggbb`, `#rgb`, or a colour name,
// which CSS knows (Ghostty takes X11 names, mostly the same).
export function cssColor(value: string | undefined): string | null {
	if (!value) return null;
	const v = value.trim();
	if (/^#?[0-9a-f]{6}$/i.test(v) || /^#?[0-9a-f]{3}$/i.test(v)) return v.startsWith("#") ? v.toLowerCase() : `#${v.toLowerCase()}`;
	if (/^[a-z]+$/i.test(v)) return v.toLowerCase();
	return null;
}

function number(value: string | undefined) {
	if (value === undefined) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function bool(value: string | undefined) {
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

// `adjust-cell-height` as xterm's lineHeight factor: a percentage or a number
// of points (on top of a cell about 1.2 font sizes high). xterm refuses
// factors below 1, so a negative adjustment leaves the height as it is.
export function lineHeight(adjust: string | undefined, fontSize: number) {
	if (!adjust) return 1;
	const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(adjust.trim());
	const factor = pct ? 1 + Number(pct[1]) / 100 : 1 + (number(adjust) ?? 0) / (fontSize * 1.2);
	return Math.max(1, Math.round(factor * 100) / 100);
}

// `background-image-position` as CSS background-position.
const POSITIONS: Record<string, string> = {
	"top-left": "left top",
	"top-center": "center top",
	"top-right": "right top",
	"center-left": "left center",
	center: "center center",
	"center-center": "center center",
	"center-right": "right center",
	"bottom-left": "left bottom",
	"bottom-center": "center bottom",
	"bottom-right": "right bottom",
};

const FITS: Record<string, string> = { contain: "contain", cover: "cover", stretch: "100% 100%", none: "auto" };

function padding(value: string | undefined): [number, number] {
	const parts = (value ?? "2").split(",").map((p) => number(p.trim()) ?? 2);
	return [parts[0], parts[1] ?? parts[0]];
}

// The cursor shapes xterm draws; Ghostty's hollow block has no xterm
// counterpart while focused, so it is a block.
function cursorStyle(value: string | undefined): "block" | "bar" | "underline" {
	if (value === "bar" || value === "underline") return value;
	return "block";
}

export function terminalAppearance(config: GhosttyConfig | null, theme: ThemeColors, overrides: AppearanceOverrides = {}): TerminalAppearance {
	const v = (key: string) => config?.values.get(key);
	const fontSize = overrides.fontSize || number(v("font-size")) || DEFAULT_FONT_SIZE;
	const background = cssColor(v("background")) ?? theme.background;
	const foreground = cssColor(v("foreground")) ?? theme.foreground;
	const xtermTheme: ITheme = {
		// The canvas is see-through; the backdrop below shows the background.
		background: "#00000000",
		foreground,
		cursor: cssColor(v("cursor-color")) ?? (config ? foreground : theme.cursor),
		cursorAccent: cssColor(v("cursor-text")) ?? background,
		selectionBackground: cssColor(v("selection-background")) ?? theme.selection,
	};
	const selectionForeground = cssColor(v("selection-foreground"));
	if (selectionForeground) xtermTheme.selectionForeground = selectionForeground;
	const extended: string[] = [];
	for (const [index, color] of config?.palette ?? []) {
		const css = cssColor(color);
		if (!css) continue;
		if (index < 16) (xtermTheme as Record<string, string>)[ANSI_NAMES[index]] = css;
		else extended[index - 16] = css;
	}
	if (extended.length) xtermTheme.extendedAnsi = extended;

	const options: TerminalAppearance["options"] = {
		theme: xtermTheme,
		allowTransparency: true,
		fontFamily: fontFamilyCss(config?.fontFamily ?? []),
		fontSize,
		lineHeight: lineHeight(v("adjust-cell-height"), fontSize),
		cursorStyle: cursorStyle(v("cursor-style")),
		// Ghostty blinks unless told not to.
		cursorBlink: bool(v("cursor-style-blink")) !== false,
		// Every option a config may set has a value here, so a look made
		// without it (Ghostty turned off) puts xterm's default back.
		fontWeight: (fontWeight(v("font-style")) ?? "normal") as ITerminalOptions["fontWeight"],
		fontWeightBold: (fontWeight(v("font-style-bold")) ?? "bold") as ITerminalOptions["fontWeightBold"],
		// Ghostty draws bold text in bright colours only with `bold-color = bright`.
		drawBoldTextInBrightColors: config ? v("bold-color") === "bright" : true,
		minimumContrastRatio: number(v("minimum-contrast")) ?? 1,
		macOptionIsMeta: (v("macos-option-as-alt") ?? "false") !== "false",
	};

	const imagePath = v("background-image");
	const image: BackdropImage | null = imagePath
		? {
				path: imagePath,
				opacity: number(v("background-image-opacity")) ?? 1,
				size: FITS[v("background-image-fit") ?? "contain"] ?? "contain",
				position: POSITIONS[v("background-image-position") ?? "center"] ?? "center center",
				repeat: bool(v("background-image-repeat")) ? "repeat" : "no-repeat",
			}
		: null;
	const opacity = number(v("background-opacity"));
	const [left, right] = padding(v("window-padding-x"));
	const [top, bottom] = padding(v("window-padding-y"));
	const off = (config?.fontFeature ?? []).filter((f) => f.startsWith("-")).map((f) => `"${f.slice(1)}" 0`);
	const on = (config?.fontFeature ?? []).filter((f) => !f.startsWith("-")).map((f) => `"${f.replace(/^\+/, "")}" 1`);
	return {
		options,
		backdrop:
			overrides.background === false
				? { color: "transparent", opacity: 0, image: null }
				: { color: background, opacity: opacity === null ? 1 : Math.min(1, Math.max(0, opacity)), image },
		padding: config ? { top, right, bottom, left } : { top: 4, right: 4, bottom: 4, left: 8 },
		fontFeatureSettings: [...off, ...on].join(", "),
	};
}
