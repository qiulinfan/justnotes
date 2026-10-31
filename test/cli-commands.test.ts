import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { installLanguageExtensions } from "../src/api/dom";
import { FileManager } from "../src/api/file-manager";
import { InternalPlugins } from "../src/api/internal-plugins";
import { MetadataCache } from "../src/api/metadata";
import { MetadataTypeManager } from "../src/api/metadata-types";
import { moment } from "../src/api/util";
import { Vault } from "../src/api/vault";
import { APP_COMMANDS } from "../src/cli/commands/app";
import type { Ctx } from "../src/cli/commands/context";
import { VAULT_COMMANDS } from "../src/cli/commands/vault";
import { writeCompletionCache } from "../src/cli/complete";
import { completionScript } from "../src/cli/completion";
import { runOffline } from "../src/cli/offline";
import { NeedsApp } from "../src/cli/output";
import { EXIT_USAGE } from "../src/cli/protocol";
import { runBuiltin } from "../src/cli/run";
import { BUILTINS } from "../src/cli/spec";

// The built-in commands against a vault on disk: the read-only ones as the
// command runs them with no app (runOffline), the writing ones through a
// headless app with the real Vault, MetadataCache and FileManager.

const FILES: Record<string, string> = {
	".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", format: "YYYY/MM-DD" }),
	".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
	".obsidian/app.json": JSON.stringify({ alwaysUpdateLinks: true }),
	"Home.md": "---\naliases: [Start]\nstatus: active\n---\n# Home\n\nSee [[Alpha]], [[Alpha]] and [[Missing]].\n\n- [ ] Write it #todo\n- [x] Read it\n- [-] Dropped\n",
	"Projects/Alpha.md": "---\nstatus: todo\npriority: 2 # keep me\n---\n# Alpha\n## Notes\nLinks to [[Beta]].\n",
	"Projects/Beta.md": "# Beta\nA dead end, with a comma, here.\n",
	"Lonely.md": "No links. #misc/sub\n",
	"Templates/Meeting.md": "# Meeting {{title}}\n",
	"All.base": "views:\n  - type: table\n    name: Projects\n    filters:\n      and:\n        - file.inFolder(\"Projects\")\n    order:\n      - file.name\n      - status\n",
};

let root: string;

beforeAll(() => {
	installLanguageExtensions();
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jn-cli-commands-")));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function makeVault(name: string, extra: Record<string, string> = {}) {
	const dir = path.join(root, name);
	for (const [file, text] of Object.entries({ ...FILES, ...extra })) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	}
	return dir;
}

const offline = (dir: string, command: string, ...words: string[]) => runOffline(BUILTINS.get(command)!, dir, words, dir, "0.0.0");

describe("read-only commands on a vault folder", () => {
	let dir: string;
	beforeAll(() => {
		dir = makeVault("read");
	});

	// Graph queries come from the resolved and unresolved link tables.
	test("backlinks count links, unresolved names their sources, orphans and dead ends follow the link graph", async () => {
		expect((await offline(dir, "backlinks", "file=Alpha", "counts")).stdout).toBe("Home.md\t2");
		expect((await offline(dir, "unresolved", "counts", "verbose")).stdout).toBe("Missing\t1\tHome.md");
		expect((await offline(dir, "orphans")).stdout.split("\n")).toEqual(["All.base", "Home.md", "Lonely.md", "Templates/Meeting.md"]);
		expect((await offline(dir, "deadends")).stdout.split("\n")).toEqual(["Lonely.md", "Projects/Beta.md", "Templates/Meeting.md"]);
	});

	test("neighbours walk links up to depth, outgoing only with direction=out", async () => {
		const both = JSON.parse((await offline(dir, "neighbours", "file=Alpha", "depth=2", "--json")).stdout);
		expect(both).toEqual([
			{ path: "Home.md", distance: 1, resolved: true },
			{ path: "Projects/Beta.md", distance: 1, resolved: true },
		]);
		expect((await offline(dir, "neighbours", "file=Home", "depth=2", "direction=out", "unresolved")).stdout.split("\n")).toEqual([
			"Missing\t1",
			"Projects/Alpha.md\t1",
			"Projects/Beta.md\t2",
		]);
	});

	test("tasks filter by state and status; verbose groups them by file with line numbers", async () => {
		expect((await offline(dir, "tasks", "todo")).stdout).toBe("- [ ] Write it #todo");
		expect((await offline(dir, "tasks", "status=-", "total")).stdout).toBe("1");
		expect((await offline(dir, "tasks", "verbose")).stdout).toBe("Home.md\n  9: - [ ] Write it #todo\n  10: - [x] Read it\n  11: - [-] Dropped");
		expect((await offline(dir, "search:context", "query=links", "case")).stdout).toBe("Lonely.md:1: No links. #misc/sub");
	});

	// tsv is headerless for cut and awk; csv has a header and quotes.
	test("list formats: tsv, csv with quoting, md, total and JSON", async () => {
		const rows = JSON.parse((await offline(dir, "search:context", "query=comma", "--json")).stdout);
		expect(rows).toEqual([{ path: "Projects/Beta.md", line: 2, text: "A dead end, with a comma, here." }]);
		expect((await offline(dir, "tasks", "done", "format=csv")).stdout).toBe("path,line,status,text\nHome.md,10,x,Read it");
		expect((await offline(dir, "tags", "counts", "format=md")).stdout).toBe("| tag | count |\n| --- | --- |\n| #misc/sub | 1 |\n| #todo | 1 |");
		expect((await offline(dir, "files", "folder=Projects", "total")).stdout).toBe("2");
		expect((await offline(dir, "files", "format=xml")).code).toBe(EXIT_USAGE);
	});

	test("properties, aliases, outline and a base's view rows", async () => {
		expect((await offline(dir, "properties", "counts")).stdout).toBe("aliases: aliases  # 1\npriority: number  # 1\nstatus: text  # 2");
		expect((await offline(dir, "aliases", "verbose")).stdout).toBe("Start\tHome.md");
		expect((await offline(dir, "outline", "file=Alpha")).stdout).toBe("Alpha\n  Notes");
		expect(JSON.parse((await offline(dir, "base:query", "file=All")).stdout)).toEqual([
			{ path: "Projects/Alpha.md", "file name": "Alpha", status: "todo" },
			{ path: "Projects/Beta.md", "file name": "Beta", status: "" },
		]);
	});

	test("daily notes and templates follow the core plugins' options", async () => {
		expect((await offline(dir, "daily:path")).stdout).toBe(`Daily/${moment().format("YYYY/MM-DD")}.md`);
		expect((await offline(dir, "template:read", "name=Meeting", "resolve", "title=Standup")).stdout).toBe("# Meeting Standup\n");
	});

	// The command then asks the app (starting it if needed), or with
	// --offline reports that it cannot answer.
	test("what needs the running app (the active file, a change) throws NeedsApp, and nothing is written", async () => {
		await expect(offline(dir, "read")).rejects.toBeInstanceOf(NeedsApp);
		const before = fs.readFileSync(path.join(dir, "Home.md"), "utf8");
		await expect(offline(dir, "task", "ref=Home.md:9", "toggle")).rejects.toBeInstanceOf(NeedsApp);
		expect((await offline(dir, "task", "ref=Home.md:9")).stdout).toBe("Home.md:9: - [ ] Write it #todo");
		expect(fs.readFileSync(path.join(dir, "Home.md"), "utf8")).toBe(before);
	});
});

// A headless app the writing commands run against, as in the vault window.
async function liveApp(dir: string) {
	const vault = new Vault(dir);
	await vault.load();
	const app = { vault, loadLocalStorage: () => null, saveLocalStorage() {}, workspace: { getActiveFile: () => null } } as unknown as App;
	app.metadataCache = new MetadataCache(vault);
	await app.metadataCache.initialize();
	app.metadataTypeManager = new MetadataTypeManager(app);
	await app.metadataTypeManager.load();
	app.internalPlugins = new InternalPlugins(app);
	await app.internalPlugins.initialize();
	app.fileManager = new FileManager(app);
	const ctx: Ctx = { app, live: true, version: "0.0.0", cwd: dir };
	const run = async (command: string, ...words: string[]) => {
		const out = await runBuiltin(BUILTINS.get(command)!, VAULT_COMMANDS[command] ?? APP_COMMANDS[command], ctx, words);
		await new Promise<void>((resolve) => app.metadataCache.onCleanCache(resolve));
		return out;
	};
	const close = () => {
		app.metadataTypeManager.unload();
		vault.close();
	};
	return { run, close, read: (file: string) => fs.readFileSync(path.join(dir, file), "utf8") };
}

describe("commands that write through the app", () => {
	let live: Awaited<ReturnType<typeof liveApp>>;
	beforeAll(async () => {
		live = await liveApp(makeVault("write"));
	});
	afterAll(() => live.close());

	// Only the property's line changes, as editing it in Properties does.
	test("property:set converts by type and rewrites only that property; a bad value changes nothing", async () => {
		expect((await live.run("property:set", "file=Alpha", "name=status", "value=done")).code).toBe(0);
		expect((await live.run("property:set", "file=Alpha", "name=topics", "value=a, b", "type=list")).code).toBe(0);
		expect(live.read("Projects/Alpha.md")).toBe("---\nstatus: done\npriority: 2 # keep me\ntopics:\n  - a\n  - b\n---\n# Alpha\n## Notes\nLinks to [[Beta]].\n");
		const bad = await live.run("property:set", "file=Alpha", "name=priority", "value=high");
		expect(bad.code).toBe(EXIT_USAGE);
		expect(live.read("Projects/Alpha.md")).toContain("priority: 2 # keep me");
	});

	test("property:remove of the last property drops the frontmatter block", async () => {
		await live.run("property:set", "file=Beta", "name=done", "value=true", "type=checkbox");
		expect(live.read("Projects/Beta.md")).toBe("---\ndone: true\n---\n# Beta\nA dead end, with a comma, here.\n");
		await live.run("property:remove", "file=Beta", "name=done");
		expect(live.read("Projects/Beta.md")).toBe("# Beta\nA dead end, with a comma, here.\n");
	});

	test("task changes only the status character", async () => {
		expect((await live.run("task", "ref=Home.md:9", "toggle")).stdout).toBe("Home.md:9: - [x] Write it #todo");
		await live.run("task", "file=Home", "line=10", "status=/");
		expect(live.read("Home.md").split("\n").slice(8, 11)).toEqual(["- [x] Write it #todo", "- [/] Read it", "- [-] Dropped"]);
		expect((await live.run("task", "file=Home", "line=1", "done")).code).toBe(1);
	});

	test("append adds a line, prepend goes after the frontmatter, inline adds no line break", async () => {
		await live.run("append", "file=Lonely", "content=Tail");
		await live.run("prepend", "file=Home", "content=Top");
		await live.run("prepend", "file=Lonely", "content=>> ", "inline");
		expect(live.read("Lonely.md")).toBe(">> No links. #misc/sub\nTail");
		expect(live.read("Home.md").startsWith("---\naliases: [Start]\nstatus: active\n---\nTop\n# Home\n")).toBe(true);
	});

	test("create fills a template and refuses to replace a file without overwrite", async () => {
		expect((await live.run("create", "path=Notes/Trip", "template=Meeting", "content=Body")).stdout).toBe("Notes/Trip.md");
		expect(live.read("Notes/Trip.md")).toBe("# Meeting Trip\nBody");
		expect((await live.run("create", "path=Notes/Trip")).code).toBe(1);
		await live.run("create", "path=Notes/Trip", "content=New", "overwrite");
		expect(live.read("Notes/Trip.md")).toBe("New");
	});

	test("move into a folder keeps the name and updates links to the note", async () => {
		expect((await live.run("move", "file=Beta", "to=Archive/")).stdout).toBe("Archive/Beta.md");
		expect(live.read("Projects/Alpha.md")).toContain("Links to [[Beta]].");
		expect((await live.run("backlinks", "path=Archive/Beta.md")).stdout).toBe("Projects/Alpha.md");
		expect((await live.run("rename", "path=Archive/Beta.md", "name=Gamma")).stdout).toBe("Archive/Gamma.md");
		expect(live.read("Projects/Alpha.md")).toContain("Links to [[Gamma]].");
	});
});

// The scripts `justnotes completion` prints ask `justnotes __complete` for
// candidates, so a plugin command the app recorded completes without a new
// script. bash splits words at = and : and drops what precedes them; a
// candidate ending in = or / takes no space.
describe("completion scripts", () => {
	function setup() {
		const dir = fs.mkdtempSync(path.join(root, "complete-"));
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		fs.symlinkSync(path.join(import.meta.dir, "../src/cli/justnotes.ts"), path.join(bin, "justnotes"));
		const profile = path.join(dir, "profile");
		const vault = path.join(dir, "notes");
		fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
		fs.writeFileSync(path.join(vault, "My Note.md"), "");
		writeCompletionCache(profile, vault, [{ name: "quickadd:run", description: "Run a choice", pluginId: "quickadd", flags: { mode: { value: "fast|slow", description: "Mode" } } }]);
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		return { dir, profile, vault, env };
	}

	test("bash replies with commands, plugin commands, parameter values and quoted note names", () => {
		const { dir, profile, vault, env } = setup();
		const script = path.join(dir, "jn.bash");
		fs.writeFileSync(script, completionScript("bash"));
		const reply = (line: string) =>
			Bun.spawnSync(["bash", "--norc", "--noprofile", "-c", `source "${script}"; COMP_LINE="justnotes --profile ${profile} ${line}"; COMP_POINT=\${#COMP_LINE}; _justnotes; printf '[%s]' "\${COMPREPLY[@]}"`], { cwd: vault, env }).stdout.toString();
		expect(reply("daily:a")).toBe("[append ]");
		expect(reply("quickadd:r")).toBe("[run ]");
		expect(reply("quickadd:run mode=")).toBe("[fast ][slow ]");
		expect(reply("outline format=")).toBe("[tree ][md ][json ]");
		expect(reply("read fi")).toBe("[file=]");
		expect(reply("read file=My")).toBe("[My\\ Note ]");
	});

	test.skipIf(!Bun.which("fish"))("fish offers the same candidates with descriptions", () => {
		const { dir, profile, vault, env } = setup();
		const script = path.join(dir, "jn.fish");
		fs.writeFileSync(script, completionScript("fish"));
		const complete = (line: string) =>
			Bun.spawnSync(["fish", "--no-config", "-c", `source ${script}; complete -C "justnotes --profile ${profile} ${line}"`], { cwd: vault, env }).stdout.toString().trim();
		expect(complete("quickadd:")).toBe("quickadd:run\tRun a choice (quickadd)");
		expect(complete("quickadd:run mode=s")).toBe("mode=slow\tMode");
		expect(complete("read file=My\\ N")).toBe("file=My Note\tMy Note.md");
	});
});
