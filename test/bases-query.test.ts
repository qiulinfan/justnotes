import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BaseDocument, BasesViewConfig } from "../src/api/bases/config";
import { QueryRun } from "../src/api/bases/entry";
import { loadPropertyTypes } from "../src/api/bases/frontmatter";
import { executeQuery } from "../src/api/bases/query";
import { DateValue, ErrorValue, LinkValue, NumberValue, StringValue } from "../src/api/bases/values";
import { MetadataCache } from "../src/api/metadata";
import { Vault } from "../src/api/vault";

// A small vault on disk, indexed by the real Vault and MetadataCache.
const FILES: Record<string, string> = {
	"tasks/a.md": "---\nstatus: todo\npriority: 2\ndue: 2025-01-10\ntags: [work]\nproject: \"[[Alpha]]\"\ndone: false\nestimate: \"5\"\n---\nSee [[Alpha]].\n",
	"tasks/b.md": "---\nstatus: done\npriority: 1\ndue: 2025-01-05\ntags: [work/urgent]\ndone: true\n---\nBody #inline\n",
	"tasks/c.md": "---\nstatus: todo\npriority: 3\ntags: [home]\n---\n",
	"Alpha.md": "# Alpha\nLinks to [[a]].\n",
	"notes/plain.md": "No frontmatter here.\n",
	"img.png": "not really a png",
	".obsidian/types.json": JSON.stringify({ types: { estimate: "number" } }),
};

let dir: string;
let vault: Vault;
let app: any;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "justnotes-bases-"));
	for (const [file, content] of Object.entries(FILES)) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		await fs.writeFile(path.join(dir, file), content);
	}
	vault = new Vault(dir);
	await vault.load();
	const metadataCache = new MetadataCache(vault);
	await metadataCache.initialize();
	app = { vault, metadataCache };
	await loadPropertyTypes(app);
});

afterAll(async () => {
	vault.close();
	await fs.rm(dir, { recursive: true, force: true });
});

// Run the base in `yaml` and return the matching paths, in order.
function query(yaml: string, viewIndex = 0, thisPath: string | null = null) {
	const doc = new BaseDocument(yaml);
	expect(doc.error).toBeNull();
	const config = new BasesViewConfig(doc.views[viewIndex], doc.config);
	const thisFile = thisPath ? vault.getFileByPath(thisPath) : null;
	const run = new QueryRun(app, doc.config.formulas, thisFile, thisPath ?? "test.base");
	const out = executeQuery(run, doc.config, config, vault.getFiles());
	return { ...out, paths: out.result.data.map((e) => e.file.path), config };
}

describe("Bases queries", () => {
	// A base with no filters lists every vault file, attachments included.
	test("without filters every file matches, sorted by path", () => {
		const { paths } = query("views:\n  - type: table\n    name: All\n");
		expect(paths).toEqual(["Alpha.md", "img.png", "notes/plain.md", "tasks/a.md", "tasks/b.md", "tasks/c.md"]);
	});

	test("global and view filters both apply, and and/or/not nest", () => {
		const yaml = `
filters:
  and:
    - file.inFolder("tasks")
views:
  - type: table
    name: Open or urgent
    filters:
      or:
        - status == "todo"
        - and:
            - priority < 2
            - not:
                - file.hasTag("home")
`;
		expect(query(yaml).paths).toEqual(["tasks/a.md", "tasks/b.md", "tasks/c.md"]);
		expect(query(yaml.replace('status == "todo"', 'status == "nothing"')).paths).toEqual(["tasks/b.md"]);
	});

	// A filter that does not parse must say so rather than silently show nothing.
	test("a filter that does not parse matches nothing and is reported", () => {
		const out = query('filters: \'status == \'\nviews:\n  - type: table\n    name: T\n');
		expect(out.paths).toEqual([]);
		expect(out.errors[0]).toContain("status ==");
	});

	test("sort applies each key in turn with empty values last, and limit cuts after sorting", () => {
		const yaml = `
filters: file.ext == "md"
views:
  - type: table
    name: By priority
    sort:
      - property: priority
        direction: DESC
      - property: file.name
        direction: ASC
    limit: 2
`;
		expect(query(yaml).paths).toEqual(["tasks/c.md", "tasks/a.md"]);
		const all = query(yaml.replace("limit: 2", "limit: 0")).paths;
		expect(all.slice(0, 3)).toEqual(["tasks/c.md", "tasks/a.md", "tasks/b.md"]);
		expect(all.slice(3)).toEqual(["Alpha.md", "notes/plain.md"]);
	});

	test("groupBy groups by value, and groupOrder picks the groups and their order", () => {
		const grouped = query(`
filters: file.inFolder("tasks")
views:
  - type: table
    name: By status
    groupBy:
      property: note.status
      direction: DESC
`);
		const groups = grouped.result.groupedData;
		expect(groups.map((g) => g.key?.toString())).toEqual(["todo", "done"]);
		expect(groups[0].entries.map((e) => e.file.path)).toEqual(["tasks/a.md", "tasks/c.md"]);

		const ordered = query(`
views:
  - type: table
    name: Chosen
    groupBy:
      property: status
    groupOrder: [done, null, archived]
`);
		const keys = ordered.result.groupedData.map((g) => [g.hasKey() ? g.key!.toString() : null, g.entries.length]);
		expect(keys).toEqual([
			["done", 1],
			[null, 3],
			["archived", 0],
		]);
	});

	test("built-in summaries and custom summary formulas run over a property's values", () => {
		const { result } = query(`
filters: file.inFolder("tasks")
summaries:
  doubled: values.map(value * 2).join("/")
views:
  - type: table
    name: T
`);
		const sum = (key: string, prop = "note.priority") => result.getSummaryValue(null, result.data, prop as any, key).toString();
		expect(sum("Sum")).toBe("6");
		expect(sum("Average")).toBe("2");
		expect(sum("median")).toBe("2");
		expect(sum("Range")).toBe("2");
		expect(sum("doubled")).toBe("4/2/6");
		expect(sum("Checked", "note.done")).toBe("1");
		expect(sum("Unchecked", "note.done")).toBe("2");
		expect(sum("Earliest", "note.due")).toBe("2025-01-05");
		expect(sum("Filled", "note.due")).toBe("2");
		expect(sum("Unique", "note.status")).toBe("2");
		expect(result.getSummaryValue(null, result.data, "note.priority", "Nope")).toBeInstanceOf(ErrorValue);
	});

	// `this` is what makes a backlinks base or an embedded "notes about this" base work.
	test("this refers to the given file, so file.hasLink(this.file) lists its backlinks", () => {
		expect(query("filters: file.hasLink(this.file)\nviews:\n  - type: table\n    name: T\n", 0, "Alpha.md").paths).toEqual(["tasks/a.md"]);
	});

	test("file properties come from the metadata cache", () => {
		const { result } = query('filters: file.path == "tasks/b.md"\nviews:\n  - type: table\n    name: T\n');
		const b = result.data[0];
		expect(b.getValue("file.tags")?.toString()).toBe("#work/urgent, #inline");
		expect(b.getValue("file.folder")?.toString()).toBe("tasks");
		expect(b.getValue("file.ext")?.toString()).toBe("md");
		expect(query('filters: file.hasTag("work")\nviews:\n  - type: table\n    name: T\n').paths).toEqual(["tasks/a.md", "tasks/b.md"]);
		const alpha = query('filters: file.name == "Alpha.md"\nviews:\n  - type: table\n    name: T\n').result.data[0];
		expect(alpha.getValue("file.backlinks")?.toString()).toBe("[[a]]");
	});

	// Frontmatter typing decides whether `due < today()` and `estimate > 3` compare at all.
	test("frontmatter is typed: types.json numbers, ISO dates and wikilinks", () => {
		const a = query('filters: file.name == "a.md"\nviews:\n  - type: table\n    name: T\n').result.data[0];
		expect(a.getValue("note.estimate")).toBeInstanceOf(NumberValue);
		expect(a.getValue("note.due")).toBeInstanceOf(DateValue);
		const project = a.getValue("note.project");
		expect(project).toBeInstanceOf(LinkValue);
		expect((project as LinkValue).resolve()?.path).toBe("Alpha.md");
		expect(a.getValue("note.status")).toBeInstanceOf(StringValue);
		expect(query('filters: project == link("Alpha")\nviews:\n  - type: table\n    name: T\n').paths).toEqual(["tasks/a.md"]);
		expect(query("filters: due < date(\"2025-01-07\")\nviews:\n  - type: table\n    name: T\n").paths).toEqual(["tasks/b.md"]);
	});

	test("allProperties lists the matching files' properties, then formulas, then file properties", () => {
		const { allProperties } = query('filters: file.name == "c.md"\nformulas:\n  x: "1"\nviews:\n  - type: table\n    name: T\n');
		expect(allProperties.slice(0, 5)).toEqual(["note.priority", "note.status", "note.tags", "formula.x", "file.name"]);
	});
});

describe("Base documents", () => {
	// Toolbar edits must not destroy the user's comments or keys Bases does not know.
	test("editing a view keeps comments and unknown keys", () => {
		const doc = new BaseDocument("# my base\nfilters: file.ext == \"md\"\ncustom: 1\nviews:\n  - type: table\n    name: T # main\n");
		const text = doc.setViewKey(0, "sort", [{ property: "file.name", direction: "ASC" }]);
		expect(text).toContain("# my base");
		expect(text).toContain("# main");
		expect(text).toContain("custom: 1");
		expect(new BaseDocument(text).views[0].sort).toEqual([{ property: "file.name", direction: "ASC" }]);
	});

	test("a base without views shows one table and writes it only when it changes", () => {
		const doc = new BaseDocument("");
		expect(doc.views).toEqual([{ type: "table", name: "Table" }]);
		expect(doc.text).toBe("");
		doc.views[0].limit = 5;
		const text = doc.setViewKey(0, "limit", 5);
		expect(new BaseDocument(text).views).toEqual([{ type: "table", name: "Table", limit: 5 }]);
	});

	test("invalid YAML or a non-mapping is an error, not an exception", () => {
		expect(new BaseDocument("views: [").error).toContain("Invalid YAML");
		expect(new BaseDocument("- a\n- b").error).toContain("mapping");
	});

	test("view config normalizes property ids, drops invalid sorts and names properties", () => {
		const doc = new BaseDocument(`
properties:
  status:
    displayName: State
  formula.cost:
    displayName: Cost
views:
  - type: table
    name: T
    order: [status, file.name, formula.cost, status]
    sort:
      - property: status
        direction: desc
      - direction: ASC
      - property: file.size
        direction: sideways
`);
		const config = new BasesViewConfig(doc.views[0], doc.config);
		expect(config.getOrder()).toEqual(["note.status", "file.name", "formula.cost"]);
		expect(config.getSort()).toEqual([{ property: "note.status", direction: "DESC" }]);
		expect(config.getDisplayName("note.status")).toBe("State");
		expect(config.getDisplayName("formula.cost")).toBe("Cost");
		expect(config.getDisplayName("file.mtime")).toBe("modified time");
		expect(config.getDisplayName("note.other")).toBe("other");
	});
});
