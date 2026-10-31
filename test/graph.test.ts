import { describe, expect, test } from "bun:test";
import { buildGraph, compileQuery, DEFAULT_OPTIONS, type GraphSource, localGraph, type QuerySubject, readOptions } from "../src/renderer/graph-data";

// graph.json as Obsidian writes it, read into the view's options.
describe("graph options", () => {
	test("graph.json values replace the defaults; wrong types are ignored and numbers clamped", () => {
		const options = readOptions({ showTags: true, repelStrength: 99, linkDistance: "far", scale: 0.49, close: false });
		expect([options.showTags, options.repelStrength, options.linkDistance, options.scale, options.close]).toEqual([true, 20, DEFAULT_OPTIONS.linkDistance, 0.49, false]);
	});

	test("colour groups keep Obsidian's shape; ones without a query are dropped", () => {
		const options = readOptions({ colorGroups: [{ query: "tag:#a", color: { a: 1, rgb: 14701138 } }, { color: { a: 1, rgb: 1 } }] });
		expect(options.colorGroups).toEqual([{ query: "tag:#a", color: { a: 1, rgb: 14701138 } }]);
	});

	test("a saved view state is read over graph.json's options, not over the defaults", () => {
		const base = readOptions({ hideUnresolved: true, linkDistance: 100 });
		const options = readOptions({ linkDistance: 300 }, base);
		expect([options.hideUnresolved, options.linkDistance]).toEqual([true, 300]);
	});
});

// The graph's search filter and its groups' queries.
describe("graph queries", () => {
	const note = (path: string, text: string | null, tags: string[] = [], frontmatter: Record<string, unknown> | null = null): QuerySubject => ({ path, text, tags, frontmatter });
	const a = note("math/Topology.md", "Open sets and compactness", ["math/topology"], { aliases: ["Top"], status: "draft" });
	const b = note("cs/Graphs.md", "Breadth-first search", ["cs"]);
	const pdf = note("math/scan.pdf", null);
	const matches = (query: string) => [a, b, pdf].filter((s) => compileQuery(query)!.test(s)).map((s) => s.path);

	test("plain words must all match the path or the contents, ignoring case", () => {
		expect(matches("open COMPACT")).toEqual(["math/Topology.md"]);
		expect(matches("math")).toEqual(["math/Topology.md", "math/scan.pdf"]);
	});

	test("OR, negation, groups and quoted phrases", () => {
		expect(matches("compact OR breadth")).toEqual(["math/Topology.md", "cs/Graphs.md"]);
		expect(matches("-path:math")).toEqual(["cs/Graphs.md"]);
		expect(matches('(path:cs OR file:scan) -"first search"')).toEqual(["math/scan.pdf"]);
	});

	test("tag: matches the tag and tags nested under it", () => {
		expect(matches("tag:#math")).toEqual(["math/Topology.md"]);
		expect(matches("tag:topology")).toEqual([]);
	});

	test("[property] and [property:value] read the frontmatter", () => {
		expect(matches("[aliases]")).toEqual(["math/Topology.md"]);
		expect(matches("[status:final]")).toEqual([]);
	});

	test("a /regex/ is case-sensitive; content terms fail on unread files", () => {
		expect(matches("file:/^[A-Z]/")).toEqual(["math/Topology.md", "cs/Graphs.md"]);
		expect(matches("content:scan")).toEqual([]);
	});

	test("only queries that look at contents ask for them", () => {
		expect([compileQuery("path:a tag:b [c] file:d")!.needsText, compileQuery("path:a OR word")!.needsText]).toEqual([false, true]);
		expect(compileQuery("   ")).toBeNull();
	});
});

const source: GraphSource = {
	files: [
		{ path: "A.md", extension: "md", tags: ["x"] },
		{ path: "B.md", extension: "md", tags: [] },
		{ path: "C.md", extension: "md", tags: ["x"] },
		{ path: "D.md", extension: "md", tags: [] },
		{ path: "Lonely.md", extension: "md", tags: [] },
		{ path: "img.png", extension: "png", tags: [] },
	],
	resolvedLinks: { "A.md": { "B.md": 2, "img.png": 1, "A.md": 1 }, "B.md": { "C.md": 1, "A.md": 1 }, "C.md": { "D.md": 1 }, "D.md": {}, "Lonely.md": {} },
	unresolvedLinks: { "A.md": { Missing: 1 }, "B.md": {}, "C.md": {}, "D.md": {}, "Lonely.md": {} },
};
const options = { showTags: false, showAttachments: false, hideUnresolved: false, showOrphans: true };
const ids = (data: { nodes: { id: string }[] }) => data.nodes.map((n) => n.id).sort();
const edges = (data: { links: { source: string; target: string }[] }) => data.links.map((l) => `${l.source}>${l.target}`).sort();

describe("global graph", () => {
	test("notes and unresolved links are nodes; self-links and links to hidden attachments are not", () => {
		const graph = buildGraph(source, options);
		expect(ids(graph)).toEqual(["A.md", "B.md", "C.md", "D.md", "Lonely.md", "Missing"]);
		expect(edges(graph)).toEqual(["A.md>B.md", "A.md>Missing", "B.md>A.md", "B.md>C.md", "C.md>D.md"]);
		expect(graph.nodes.find((n) => n.id === "Missing")?.type).toBe("unresolved");
	});

	test("attachments and tags join when shown; existing files only drops unresolved links", () => {
		const graph = buildGraph(source, { ...options, showAttachments: true, showTags: true, hideUnresolved: true });
		expect(ids(graph)).toEqual(["#x", "A.md", "B.md", "C.md", "D.md", "Lonely.md", "img.png"]);
		expect(edges(graph).filter((e) => e.includes("#x") || e.includes("img"))).toEqual(["A.md>#x", "A.md>img.png", "C.md>#x"]);
	});

	test("without orphans, nodes no link touches are dropped; weight counts links both ways", () => {
		const graph = buildGraph(source, { ...options, showOrphans: false });
		expect(ids(graph)).not.toContain("Lonely.md");
		expect(graph.nodes.find((n) => n.id === "B.md")?.weight).toBe(3);
	});

	test("the search filter removes files and the links and unresolved nodes they bring", () => {
		const graph = buildGraph({ ...source, filter: (f) => f.path !== "A.md" }, options);
		expect(ids(graph)).toEqual(["B.md", "C.md", "D.md", "Lonely.md"]);
	});
});

describe("local graph", () => {
	const global = buildGraph(source, options);
	const local = (center: string, o: Partial<typeof DEFAULT_OPTIONS> = {}) => localGraph(global, center, { ...DEFAULT_OPTIONS, ...o });

	test("depth counts link steps in both directions by default", () => {
		expect(ids(local("C.md"))).toEqual(["B.md", "C.md", "D.md"]);
		expect(ids(local("C.md", { localJumps: 2 }))).toEqual(["A.md", "B.md", "C.md", "D.md"]);
	});

	test("incoming and outgoing links can each be turned off", () => {
		expect(ids(local("C.md", { localBacklinks: false, localJumps: 3 }))).toEqual(["C.md", "D.md"]);
		expect(ids(local("C.md", { localForelinks: false, localJumps: 3 }))).toEqual(["A.md", "B.md", "C.md"]);
	});

	test("links between neighbours show only with neighbor links on", () => {
		const add = { ...source, resolvedLinks: { ...source.resolvedLinks, "D.md": { "B.md": 1 } } };
		const g = buildGraph(add, options);
		const around = (interlinks: boolean) => edges(localGraph(g, "C.md", { ...DEFAULT_OPTIONS, localInterlinks: interlinks }));
		expect(around(false)).toEqual(["B.md>C.md", "C.md>D.md"]);
		expect(around(true)).toEqual(["B.md>C.md", "C.md>D.md", "D.md>B.md"]);
	});

	test("a note outside the graph (filtered out or deleted) has an empty local graph", () => {
		expect(local("Gone.md").nodes).toEqual([]);
	});
});
