import { describe, expect, test } from "bun:test";
import { ColorComponent } from "../src/api/ui/setting";
import { findPage, type SettingDefinitionItem, searchDefinitions } from "../src/api/ui/setting-definitions";

// A trimmed copy of the shapes obsidian-git and quickadd return from
// getSettingDefinitions(): top-level rows, groups, nested declarative pages.
const items: SettingDefinitionItem[] = [
	{ name: "Git is not ready", desc: "Check the repository paths", visible: () => false },
	{
		type: "group",
		heading: "Input",
		items: [
			{ name: "Use multi-line input prompt", control: { type: "toggle", key: "inputPrompt" } },
			{ name: "Date aliases", aliases: ["shortcodes"], render: () => {} },
			{ name: "Internal", searchable: false },
		],
	},
	{
		type: "group",
		heading: "AI & online",
		items: [
			{
				type: "page",
				name: "AI Assistant",
				items: [
					{ type: "list", heading: "Providers", items: [{ type: "page", name: "OpenAI", desc: "api.openai.com", page: () => ({}) as any }] },
					{ type: "group", heading: "Defaults", items: [{ name: "Default model", aliases: ["LLM"], render: () => {} }] },
				],
			},
		],
	},
];

// The settings sidebar search lists these results and navigates by pagePath.
describe("searchDefinitions", () => {
	test("matches names, aliases and descriptions, with the page path to open", () => {
		expect(searchDefinitions(items, "llm")).toEqual([{ name: "Default model", pagePath: ["AI Assistant"] }]);
		expect(searchDefinitions(items, "shortcodes")).toEqual([{ name: "Date aliases", pagePath: [] }]);
		expect(searchDefinitions(items, "openai.com")).toEqual([{ name: "OpenAI", pagePath: ["AI Assistant"] }]);
	});

	test("skips hidden and unsearchable items", () => {
		expect(searchDefinitions(items, "repository")).toEqual([]);
		expect(searchDefinitions(items, "internal")).toEqual([]);
	});
});

// navigateToSearchResult and update() re-resolve open pages by their names.
describe("findPage", () => {
	test("follows page names through groups and lists", () => {
		expect(findPage(items, ["AI Assistant", "OpenAI"])?.desc).toBe("api.openai.com");
	});

	test("a path that no longer exists resolves to nothing", () => {
		expect(findPage(items, ["AI Assistant", "Anthropic"])).toBeNull();
	});
});

// Plugins read colors back in Obsidian's units: RGB 0-255, HSL in degrees
// and percentages; setters take the same units.
describe("ColorComponent", () => {
	const picker = () => {
		const input = { value: "#000000", disabled: false, addEventListener() {} };
		return new ColorComponent({ createEl: () => input } as unknown as HTMLElement);
	};

	test("converts the hex value to RGB and HSL", () => {
		const color = picker().setValue("#ff0000");
		expect(color.getValueRgb()).toEqual({ r: 255, g: 0, b: 0, a: 1 });
		expect(color.getValueHsl()).toEqual({ h: 0, s: 100, l: 50 });
	});

	test("sets the hex value from RGB and from HSL percentages", () => {
		expect(picker().setValueRgb({ r: 0, g: 128, b: 255 }).getValue()).toBe("#0080ff");
		expect(picker().setValueHsl({ h: 120, s: 100, l: 50 }).getValue()).toBe("#00ff00");
	});
});
