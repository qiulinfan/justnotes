import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { boundsOf, type HistoryState, LeafHistory, Tasks } from "../src/api/workspace";

afterEach(() => mock.restore());

// Plugins hand their cleanup to the 'quit' event's Tasks, and the window only
// closes once promise() settles; one failing task must not cut the rest short.
describe("Tasks", () => {
	test("promise() settles only after every task, failed ones included", async () => {
		spyOn(console, "error").mockImplementation(() => {});
		const tasks = new Tasks();
		const done: string[] = [];
		tasks.add(async () => {
			await Bun.sleep(20);
			done.push("slow");
		});
		tasks.add(() => {
			throw new Error("thrown before returning a promise");
		});
		tasks.addPromise(Promise.reject(new Error("rejected")));
		tasks.addPromise(Bun.sleep(5).then(() => done.push("fast")));
		expect(tasks.isEmpty()).toBe(false);
		await tasks.promise();
		expect(done.sort()).toEqual(["fast", "slow"]);
	});

	test("add() starts the task right away, before the app waits", () => {
		const tasks = new Tasks();
		let started = false;
		tasks.add(async () => {
			started = true;
		});
		expect(started).toBe(true);
	});
});

// app:go-back and app:go-forward walk a leaf's history; a wrong stack order
// sends the user to the wrong note.
describe("LeafHistory", () => {
	const entry = (title: string): HistoryState => ({ title, icon: "", state: { type: "markdown", state: { file: `${title}.md` } }, eState: {} });

	function leaf(start: string) {
		let current = entry(start);
		const history = new LeafHistory(
			() => current,
			async (state) => {
				current = state;
			},
		);
		const open = (title: string) => {
			history.pushState(current);
			current = entry(title);
		};
		return { history, open, now: () => current.title };
	}

	test("back and forward retrace the visited notes", async () => {
		const l = leaf("a");
		l.open("b");
		l.open("c");
		await l.history.back();
		expect(l.now()).toBe("b");
		await l.history.back();
		expect(l.now()).toBe("a");
		await l.history.forward();
		expect(l.now()).toBe("b");
		await l.history.forward();
		await l.history.forward();
		expect(l.now()).toBe("c");
	});

	test("go(n) jumps several entries and keeps the skipped ones for the way back", async () => {
		const l = leaf("a");
		l.open("b");
		l.open("c");
		l.open("d");
		await l.history.go(-3);
		expect(l.now()).toBe("a");
		await l.history.go(2);
		expect(l.now()).toBe("c");
		await l.history.forward();
		expect(l.now()).toBe("d");
	});

	// A plugin view whose getState throws must not trap the user in its leaf.
	test("back from a view whose state cannot be read still navigates, with nothing to come forward to", async () => {
		let shown: HistoryState | null = null;
		const history = new LeafHistory(
			() => shown,
			async (state) => {
				shown = state;
			},
		);
		history.pushState(entry("a"));
		await history.back();
		expect(shown).toEqual(entry("a"));
		expect(history.forwardHistory).toEqual([]);
	});

	test("opening a note after going back drops what was ahead", async () => {
		const l = leaf("a");
		l.open("b");
		await l.history.back();
		l.open("x");
		expect(l.history.forwardHistory).toEqual([]);
		await l.history.back();
		expect(l.now()).toBe("a");
	});
});

// moveLeafToPopout and openPopoutLeaf take Obsidian's WorkspaceWindowInitData;
// a size without both dimensions would open a zero-sized window.
describe("boundsOf", () => {
	test("position and size carry over; a missing or empty size is left to the default", () => {
		expect(boundsOf({ x: 10, y: 20, size: { width: 640, height: 480 } })).toEqual({ x: 10, y: 20, width: 640, height: 480 });
		expect(boundsOf({ size: { width: 0, height: 480 } })).toEqual({});
		expect(boundsOf(undefined)).toEqual({});
	});
});
