import { describe, expect, test } from "bun:test";
import { sameAppPage } from "../src/main/link-policy";
import { POPOUT_FRAME, isPopoutOpen } from "../src/main/popout";
import { popoutFeatures } from "../src/api/popout-window";

// Main lets exactly one window.open through as a window of the app: the blank
// popout the workspace opens. Everything else is a link and goes to the link
// policy, so a note's link can never open an app window with the page's
// powers, and a popout is never handed to the system browser.
describe("isPopoutOpen", () => {
	test("about:blank under the popout frame name opens a popout window", () => {
		expect(isPopoutOpen("about:blank", `${POPOUT_FRAME}-0123abcd`)).toBe(true);
	});

	test("a URL under the popout frame name, or about:blank under another name, is a link", () => {
		expect(isPopoutOpen("https://example.com/", `${POPOUT_FRAME}-0123abcd`)).toBe(false);
		expect(isPopoutOpen("file:///etc/passwd", POPOUT_FRAME)).toBe(false);
		expect(isPopoutOpen("about:blank", "_blank")).toBe(false);
	});
});

// Chromium reads these features to size and place the window; fractional
// pixels from layout rects or a missing value must not produce an invalid one.
describe("popoutFeatures", () => {
	test("bounds are rounded and unknown ones left out", () => {
		expect(popoutFeatures({ x: 10.6, y: undefined, width: 800.2, height: 600 })).toBe("popup,width=800,height=600,left=11");
		expect(popoutFeatures({ x: Number.NaN })).toBe("popup");
	});
});

// A vault window navigates only within its own page; anything else is a link
// for the link policy. A link to the app page with another ?vault= once
// loaded that folder, and its plugins, in the window.
describe("sameAppPage", () => {
	const page = "file:///app/dist/index.html?vault=%2Fnotes";

	test("the page itself, with or without a fragment, stays", () => {
		expect(sameAppPage(page, page)).toBe(true);
		expect(sameAppPage(`${page}#top`, page)).toBe(true);
	});

	test("the app page with another vault, or another file, is a link", () => {
		expect(sameAppPage("file:///app/dist/index.html?vault=%2Ftmp%2Fother", page)).toBe(false);
		expect(sameAppPage("file:///app/dist/index.html", page)).toBe(false);
		expect(sameAppPage("file:///etc/passwd", page)).toBe(false);
	});
});
