import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CliFlags, CliHandler } from "../src/api/plugin";
import { completeWords, readCompletionCache, writeCompletionCache } from "../src/cli/complete";
import { ask, type CliRequest, type CliResponse, cliAddress, EXIT_USAGE } from "../src/cli/protocol";
import { closeCli, serveCli } from "../src/main/cli-server";
import { pickVault } from "../src/cli/vaults";
import { parseCliArgs } from "../src/cli/args";
import { runCli } from "../src/renderer/cli";

// QuickAdd's flags for `quickadd:run` and `quickadd:list`, as its main.js
// registers them, plus a required one.
const runFlags: CliFlags = {
	choice: { value: "<name>", description: "Choice name" },
	vars: { value: "<json>", description: "Variables object as JSON" },
	ui: { description: "Allow interactive prompts" },
};

function host(handlers: Record<string, { flags: CliFlags | null; handler: CliHandler; description?: string }>) {
	const cliHandlers = new Map<string, { description: string; flags: CliFlags | null; handler: CliHandler; pluginId: string }>();
	for (const [name, { flags, handler, description }] of Object.entries(handlers)) {
		cliHandlers.set(name, { description: description ?? `${name} description`, flags, handler, pluginId: "quickadd" });
	}
	return { cliHandlers };
}

// Obsidian's syntax (key=value, bare flags, \n in values) and the --key forms
// reach the handler as its CliData.
describe("parseCliArgs", () => {
	test("parameters, switches and escapes become the handler's params", () => {
		const parsed = parseCliArgs(["choice=Daily log", "ui", "vars={\"a\":\"x\\ny\"}", "--verify", "--date=last friday"], runFlags);
		expect(parsed).toEqual({ params: { choice: "Daily log", ui: "true", vars: '{"a":"x\ny"}', verify: "true", date: "last friday" } });
		expect(parseCliArgs(["path=C:\\\\notes\\\\a.md", "tab=a\\tb"], null)).toEqual({ params: { path: "C:\\notes\\a.md", tab: "a\tb" } });
	});

	test("--key takes the next word for a valued or undeclared flag, never for a declared switch", () => {
		expect(parseCliArgs(["--choice", "Inbox", "--ui", "extra"], runFlags)).toEqual({ params: { choice: "Inbox", ui: "true", extra: "true" } });
		expect(parseCliArgs(["--value-title", "Hello", "--verify", "--date", "today", "--last"], runFlags)).toEqual({
			params: { "value-title": "Hello", verify: "true", date: "today", last: "true" },
		});
		expect(parseCliArgs(["--verify", "choice=Inbox"], runFlags)).toEqual({ params: { verify: "true", choice: "Inbox" } });
	});

	test("keys the handler did not declare pass through (QuickAdd's value-<id>)", () => {
		expect(parseCliArgs(["choice=Inbox", "value-title=Hello world"], runFlags)).toEqual({ params: { choice: "Inbox", "value-title": "Hello world" } });
	});

	test("a valued flag given bare, an empty key and a missing required flag are usage errors", () => {
		expect(parseCliArgs(["choice"], runFlags)).toEqual({ error: "choice needs a value: choice=<name>" });
		expect(parseCliArgs(["--choice"], runFlags)).toEqual({ error: "choice needs a value: choice=<name>" });
		expect(parseCliArgs(["=x"], runFlags)).toHaveProperty("error");
		const required: CliFlags = { path: { value: "<vault-path>", description: "Template", required: true }, ui: { description: "", required: true } };
		expect(parseCliArgs([], required)).toEqual({ error: "Missing required flags: path=<vault-path> ui" });
	});
});

describe("runCli", () => {
	test("a handler's output, or its error with status 1; an unknown command or bad flag is status 2", async () => {
		const seen: unknown[] = [];
		const app = host({
			"quickadd:run": {
				flags: runFlags,
				handler: async (params) => {
					seen.push(params);
					return JSON.stringify({ ok: true });
				},
			},
			broken: {
				flags: null,
				handler: () => {
					throw new Error("boom");
				},
			},
		});
		expect(await runCli(app, ["quickadd:run", "choice=Inbox"])).toEqual({ stdout: '{"ok":true}', stderr: "", code: 0 });
		expect(seen).toEqual([{ choice: "Inbox" }]);
		expect(await runCli(app, ["broken"])).toEqual({ stdout: "", stderr: "boom", code: 1 });
		expect((await runCli(app, ["nope"])).code).toBe(EXIT_USAGE);
		const bad = await runCli(app, ["quickadd:run", "choice"]);
		expect(bad.code).toBe(EXIT_USAGE);
		expect(seen).toHaveLength(1);
	});

	test("help lists the built-ins and the plugins' commands; help <command> shows its flags", async () => {
		const app = host({
			"quickadd:run": { flags: runFlags, handler: () => "", description: "Run a QuickAdd choice" },
			"quickadd:list": { flags: null, handler: () => "", description: "List QuickAdd choices" },
		});
		const list = (await runCli(app, [])).stdout.split("\n");
		expect(list).toContain("Files and folders:");
		const plugins = list.slice(list.indexOf("Plugin commands:") + 1, list.indexOf("", list.indexOf("Plugin commands:")));
		expect(plugins.map((line) => line.trim().split(/\s{2,}/))).toEqual([
			["quickadd:list", "List QuickAdd choices (quickadd)"],
			["quickadd:run", "Run a QuickAdd choice (quickadd)"],
		]);
		const one = await runCli(app, ["help", "quickadd:run"]);
		expect(one.stdout).toContain("choice=<name>  Choice name");
		expect(one.stdout).toContain("ui             Allow interactive prompts");
		expect((await runCli(app, ["help", "nope"])).code).toBe(EXIT_USAGE);
	});

	// Obsidian commands justnotes leaves out say why, as a usage error.
	test("an Obsidian command justnotes leaves out names the reason", async () => {
		const out = await runCli(host({}), ["publish:site"]);
		expect(out).toEqual({ stdout: "", stderr: "justnotes has no Obsidian Publish.", code: EXIT_USAGE });
	});
});

// Which vault a request runs in: vault= first, by name (open vaults, then
// known ones) or by path; else the vault the command ran in, open, known or
// marked by .obsidian; else the focused one.
describe("pickVault", () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jn-cli-vaults-")));
	const notes = path.join(root, "notes");
	const work = path.join(root, "work");
	const otherNotes = path.join(root, "other/notes");
	const unopened = path.join(root, "plain");
	for (const dir of [path.join(notes, "sub"), work, otherNotes, path.join(unopened, ".obsidian"), path.join(unopened, "deep")]) fs.mkdirSync(dir, { recursive: true });
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

	test("vault= picks by folder name or by path, says whether a window shows it, and is not passed on", () => {
		expect(pickVault(["vault=work", "help"], "/", [notes, work], [], notes)).toEqual({ vault: work, open: true, argv: ["help"] });
		expect(pickVault(["vault=../work", "x"], notes, [notes, work], [], null)).toEqual({ vault: work, open: true, argv: ["x"] });
		expect(pickVault(["vault=work", "x"], "/", [notes], [work], notes)).toEqual({ vault: work, open: false, argv: ["x"] });
	});

	test("an ambiguous or unknown vault= is a usage error", () => {
		expect(pickVault(["vault=notes", "x"], "/", [notes, otherNotes], [], null)).toMatchObject({ code: EXIT_USAGE });
		expect(pickVault(["vault=missing", "x"], "/", [notes], [], null)).toMatchObject({ code: EXIT_USAGE });
	});

	test("without vault=, the vault holding the working folder wins over the focused one", () => {
		expect(pickVault(["x"], path.join(notes, "sub"), [notes, work], [], work)).toEqual({ vault: notes, open: true, argv: ["x"] });
		expect(pickVault(["x"], path.join(unopened, "deep"), [work], [], work)).toEqual({ vault: unopened, open: false, argv: ["x"] });
		expect(pickVault(["x"], root, [notes, work], [], work)).toEqual({ vault: work, open: true, argv: ["x"] });
		expect(pickVault(["x"], root, [], [], null)).toMatchObject({ code: EXIT_USAGE });
	});
});

// The socket the `justnotes` command reaches the app over.
describe("command-line socket", () => {
	const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jn-cli-")));
	// ask() moves into the socket's folder when its path is long, as the
	// one-shot command may; later tests must not start in a removed folder.
	const home = process.cwd();
	afterEach(() => process.chdir(home));
	afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
	const echo = async (req: { argv: string[]; cwd: string }): Promise<CliResponse> => ({ stdout: req.argv.join(" "), stderr: req.cwd, code: 3 });

	test("a request reaches the dispatcher and its answer comes back; only the owner can reach the socket", async () => {
		const profile = fs.mkdtempSync(path.join(scratch, "p-"));
		const address = cliAddress(profile);
		const server = await serveCli(address, echo);
		expect(server).not.toBeNull();
		try {
			expect(await ask(address, { argv: ["quickadd:list", "type=Capture"], cwd: "/somewhere" })).toEqual({ stdout: "quickadd:list type=Capture", stderr: "/somewhere", code: 3 });
			expect(fs.statSync(address.dir!).mode & 0o777).toBe(0o700);
			expect(fs.statSync(address.path).mode & 0o777).toBe(0o600);
		} finally {
			closeCli(server!, address);
		}
		expect(fs.existsSync(address.path)).toBe(false);
	});

	test("a profile path too long for a socket address still works", async () => {
		const deep = path.join(scratch, "d".repeat(60), "e".repeat(60));
		fs.mkdirSync(deep, { recursive: true });
		const address = cliAddress(deep);
		const server = await serveCli(address, echo);
		const cwd = process.cwd();
		try {
			expect((await ask(address, { argv: ["help"], cwd: "/" })).stdout).toBe("help");
		} finally {
			process.chdir(cwd);
			closeCli(server!, address);
		}
	});

	test("a second instance leaves a live socket alone; a dead one's socket file is replaced", async () => {
		const profile = fs.mkdtempSync(path.join(scratch, "p-"));
		const address = cliAddress(profile);
		const first = await serveCli(address, echo);
		expect(await serveCli(address, echo)).toBeNull();
		closeCli(first!, address);
		// A process killed while listening leaves its socket file behind.
		const crash = `require("node:net").createServer().listen(${JSON.stringify(address.path)}, () => process.kill(process.pid, "SIGKILL"))`;
		Bun.spawnSync(["bun", "-e", crash]);
		expect(fs.existsSync(address.path)).toBe(true);
		const again = await serveCli(address, echo);
		try {
			expect((await ask(address, { argv: ["x"], cwd: "/" })).stdout).toBe("x");
		} finally {
			closeCli(again!, address);
		}
	});

	test("the command prints the answer and exits with its status, or says no app is running", async () => {
		const profile = fs.mkdtempSync(path.join(scratch, "p-"));
		const address = cliAddress(profile);
		const command = path.join(import.meta.dir, "../src/cli/justnotes.ts");
		const run = (...args: string[]) => Bun.spawnSync(["bun", command, "--profile", profile, ...args], { cwd: scratch });
		const down = run("quit");
		expect(down.exitCode).toBe(1);
		expect(down.stderr.toString()).toContain("not running");
		// Outside any vault, with no app, version still answers.
		const version = run("version", "--json");
		expect(version.exitCode).toBe(0);
		expect(JSON.parse(version.stdout.toString()).obsidianApi).toMatch(/^\d+\.\d+\.\d+$/);
		const server = await serveCli(address, echo);
		try {
			const proc = Bun.spawn(["bun", command, "--profile", profile, "vault=notes", "quickadd:list"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
			expect(await proc.exited).toBe(3);
			expect(await new Response(proc.stdout).text()).toBe("vault=notes quickadd:list\n");
			expect(await new Response(proc.stderr).text()).toBe(`${scratch}\n`);
		} finally {
			closeCli(server!, address);
		}
	});

	// A read-only command names its vault to the app, which answers with
	// `unopened` when no window shows it; the command then reads the folder.
	test("a read-only command the app has no window for is read from the vault folder", async () => {
		const profile = fs.mkdtempSync(path.join(scratch, "p-"));
		const vault = fs.mkdtempSync(path.join(scratch, "v-"));
		fs.writeFileSync(path.join(vault, "a.md"), "Hello\n");
		const address = cliAddress(profile);
		const seen: { read?: boolean }[] = [];
		const server = await serveCli(address, async (req) => {
			seen.push({ read: req.read });
			return { stdout: "", stderr: "", code: 0, unopened: vault };
		});
		try {
			const command = path.join(import.meta.dir, "../src/cli/justnotes.ts");
			const proc = Bun.spawn(["bun", command, "--profile", profile, "read", "file=a"], { cwd: scratch, stdout: "pipe" });
			expect(await proc.exited).toBe(0);
			expect(await new Response(proc.stdout).text()).toBe("Hello\n");
			expect(seen).toEqual([{ read: true }]);
		} finally {
			closeCli(server!, address);
		}
	});
});

// `justnotes __complete`: the candidates the completion scripts offer. The
// built-ins need nothing; a vault's plugin commands come from the running
// app, else from the cache the app keeps in the profile.
describe("completion candidates", () => {
	const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jn-complete-")));
	afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
	const quickadd = [
		{
			name: "quickadd:run",
			description: "Run a choice",
			pluginId: "quickadd",
			flags: { choice: { value: "<name>", description: "Choice name" }, mode: { value: "fast|slow", description: "Mode" }, ui: { description: "Allow prompts" } },
		},
	];

	function setup() {
		const profile = fs.mkdtempSync(path.join(scratch, "p-"));
		const vault = fs.mkdtempSync(path.join(scratch, "v-"));
		for (const [file, text] of Object.entries({ "Home.md": "", "Projects/Alpha.md": "", "Projects/Deep/Beta.md": "", "Projects/pic.png": "", ".hidden/Gamma.md": "" })) {
			fs.mkdirSync(path.dirname(path.join(vault, file)), { recursive: true });
			fs.writeFileSync(path.join(vault, file), text);
		}
		fs.writeFileSync(path.join(profile, "vaults.json"), JSON.stringify([vault]));
		const words = (...line: string[]) => completeWords(["--profile", profile, `vault=${path.basename(vault)}`, ...line], scratch).then((cs) => cs.map((c) => c.word));
		return { profile, vault, words };
	}

	test("the cache keeps each vault's commands privately and drops what is malformed", () => {
		const { profile, vault } = setup();
		writeCompletionCache(profile, vault, quickadd);
		writeCompletionCache(profile, "/other", [{ name: "two words" }, { name: "ok", flags: { "a b": { description: "x" }, k: { value: 3, description: "y" } } }, 7]);
		expect(readCompletionCache(profile)).toEqual({ [vault]: quickadd, "/other": [{ name: "ok", description: "", pluginId: "", flags: { k: { description: "y" } } }] });
		expect(fs.statSync(path.join(profile, "cli")).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.join(profile, "cli", "completion.json")).mode & 0o777).toBe(0o600);
	});

	test("without an app, built-ins complete and the vault's plugin commands come from the cache", async () => {
		const { profile, vault, words } = setup();
		expect(await words("")).toContain("read");
		expect(await words("")).not.toContain("quickadd:run");
		writeCompletionCache(profile, vault, quickadd);
		expect(await words("")).toEqual(expect.arrayContaining(["read", "quickadd:run"]));
		// Not offered again: a vault= after one, a flag already given.
		expect(await words("")).not.toContain("vault=");
		expect(await words("quickadd:run", "ui", "")).toEqual(["choice=", "mode=fast", "mode=slow", "--copy"]);
		expect(await words("quickadd:run", "mode=")).toEqual(["mode=fast", "mode=slow"]);
		expect(await words("help", "")).toContain("quickadd:run");
		// Another folder, no vault=: no vault, so built-ins only.
		expect((await completeWords(["--profile", profile, ""], scratch)).map((c) => c.word)).not.toContain("quickadd:run");
		expect((await completeWords(["--profile", profile, "vault="], scratch)).map((c) => c.word)).toEqual([`vault=${path.basename(vault)}`]);
	});

	test("file= offers note names, path= one folder level, never hidden folders", async () => {
		const { words } = setup();
		expect(await words("read", "file=")).toEqual(["file=Alpha", "file=Beta", "file=Home", "file=pic.png"]);
		expect(await words("read", "file=b")).toEqual(["file=Beta"]);
		expect(await words("read", "path=")).toEqual(["path=Home.md", "path=Projects/"]);
		expect(await words("read", "path=Projects/")).toEqual(["path=Projects/Alpha.md", "path=Projects/Deep/", "path=Projects/pic.png"]);
		expect(await words("read", "path=../")).toEqual([]);
	});

	// The app answers from what the vault's window reported; the command it
	// would run is never sent, so completing runs nothing.
	test("with an app running, its answer wins over the cache and only a completion request reaches it", async () => {
		const { profile, vault, words } = setup();
		writeCompletionCache(profile, vault, quickadd);
		const seen: CliRequest[] = [];
		const address = cliAddress(profile);
		const live = [{ name: "probe:echo", description: "Echo", pluginId: "probe", flags: { level: { value: "low|high", description: "Level" } } }];
		const server = await serveCli(address, async (req) => {
			seen.push(req);
			return { stdout: JSON.stringify({ vault, commands: live }), stderr: "", code: 0 };
		});
		try {
			const commands = await words("");
			expect(commands).toContain("probe:echo");
			expect(commands).not.toContain("quickadd:run");
			expect(await words("probe:echo", "level=")).toEqual(["level=low", "level=high"]);
			expect(await words("read", "file=H")).toEqual(["file=Home"]);
			expect(seen.length).toBeGreaterThan(0);
			for (const req of seen) expect(req).toEqual({ argv: [`vault=${path.basename(vault)}`], cwd: scratch, complete: true });
		} finally {
			closeCli(server!, address);
		}
	});

	test("an app that does not answer in time leaves the cache to answer", async () => {
		const { profile, vault, words } = setup();
		writeCompletionCache(profile, vault, quickadd);
		const address = cliAddress(profile);
		const server = await serveCli(address, () => new Promise<CliResponse>(() => {}));
		try {
			const started = Date.now();
			expect(await words("")).toContain("quickadd:run");
			expect(Date.now() - started).toBeLessThan(1000);
		} finally {
			closeCli(server!, address);
		}
	});
});
