import { describe, expect, test } from "bun:test";
import { edgeVelocity, SCROLL_BAND, selectionScrollSpeed } from "../src/api/selection-scroll";

// The speed a drag-select scrolls at, which the Selection scroll speed setting tunes.
describe("selectionScrollSpeed", () => {
	test("starts inside the edge band, is several times CodeMirror's at the edge and accelerates past it", () => {
		expect(selectionScrollSpeed(-SCROLL_BAND - 1, 5)).toBe(0);
		const edge = selectionScrollSpeed(0, 5);
		// CodeMirror 6 scrolls 0.7 px per px past the edge + 8 px every 50 ms.
		const codemirror = (past: number) => (Math.max(0, past) * 0.7 + 8) * 20;
		expect(edge).toBeGreaterThan(5 * codemirror(0));
		// Speed gained per px farther out grows: it accelerates.
		const slopes = [0, 10, 30, 60, 120].map((d) => selectionScrollSpeed(d + 1, 5) - selectionScrollSpeed(d, 5));
		for (let i = 1; i < slopes.length; i++) expect(slopes[i]).toBeGreaterThan(slopes[i - 1]);
		expect(slopes[0]).toBeGreaterThan(0);
	});

	test("scales with the setting, 1 staying near CodeMirror's speed at the edge", () => {
		expect(selectionScrollSpeed(30, 10)).toBeCloseTo(2 * selectionScrollSpeed(30, 5));
		const slowest = selectionScrollSpeed(0, 1);
		expect(slowest).toBeGreaterThan(160);
		expect(slowest).toBeLessThan(400);
	});
});

describe("edgeVelocity", () => {
	test("scrolls up above the top, down below the bottom, not in between", () => {
		expect(edgeVelocity(300, 100, 700, 5)).toBe(0);
		expect(edgeVelocity(720, 100, 700, 5)).toBe(selectionScrollSpeed(20, 5));
		expect(edgeVelocity(80, 100, 700, 5)).toBe(-selectionScrollSpeed(20, 5));
		expect(edgeVelocity(695, 100, 700, 5)).toBeGreaterThan(0);
	});
});
