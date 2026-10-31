import { describe, expect, test } from "bun:test";
import { Events } from "../src/api/events";
import { convertValue, MetadataTypeManager } from "../src/api/metadata-types";

// An app with notes' frontmatter, a types.json and per-vault localStorage.
function appWith(frontmatters: Record<string, Record<string, unknown>>, typesJson: unknown, storage = new Map<string, string>()) {
	const vault = Object.assign(new Events(), {
		configDir: ".obsidian",
		adapter: {
			read: async (path: string) => {
				if (path === ".obsidian/types.json" && typesJson !== undefined) return JSON.stringify(typesJson);
				throw new Error("ENOENT");
			},
		},
	});
	const metadataCache = Object.assign(new Events(), {
		getCachedFiles: () => Object.keys(frontmatters),
		getCache: (path: string) => ({ frontmatter: frontmatters[path] }),
	});
	return {
		vault,
		metadataCache,
		storage,
		loadLocalStorage: (key: string) => (storage.has(key) ? JSON.parse(storage.get(key)!) : null),
		saveLocalStorage: (key: string, data: unknown) => (data === null ? storage.delete(key) : storage.set(key, JSON.stringify(data))),
	};
}

async function managerFor(...args: Parameters<typeof appWith>) {
	const app = appWith(...args);
	const manager = new MetadataTypeManager(app as any);
	await manager.load();
	return { app, manager };
}

const NOTES = {
	"a.md": { Rating: 4, status: "x", due: "2025-01-01", tags: ["t"] },
	"b.md": { rating: "high", due: "2025-02-01" },
	"c.md": { due: "soon" },
};

describe("metadataTypeManager", () => {
	test("assigned types layer: Obsidian's defaults, then types.json, then justnotes' changes", async () => {
		const { manager } = await managerFor(NOTES, { types: { rating: "number", tags: "multitext" } });
		expect(manager.getAssignedType("Rating")).toBe("number");
		// types.json overrides a default, as in Obsidian.
		expect(manager.getAssignedType("tags")).toBe("multitext");
		expect(manager.getAssignedType("aliases")).toBe("aliases");
		manager.setType("rating", "text");
		expect(manager.getAssignedType("rating")).toBe("text");
		manager.unsetType("tags");
		expect(manager.getAssignedType("tags")).toBeNull();
	});

	test("a type change is kept in localStorage, never in types.json, and survives a reload", async () => {
		const { app, manager } = await managerFor(NOTES, { types: { rating: "number" } });
		const changed: unknown[] = [];
		manager.on("changed", (name: string) => changed.push(name));
		manager.setType("status", "multitext");
		expect(changed).toEqual(["status"]);
		expect(JSON.parse(app.storage.get("property-types")!)).toEqual({ status: { name: "status", type: "multitext" } });
		const { manager: again } = await managerFor(NOTES, { types: { rating: "number" } }, app.storage);
		expect(again.getAssignedType("STATUS")).toBe("multitext");
		expect(again.getAssignedType("rating")).toBe("number");
	});

	test("properties are counted across notes case-insensitively, typed by assignment or by most values", async () => {
		const { manager } = await managerFor(NOTES, undefined);
		expect(manager.getPropertyInfo("rating")).toMatchObject({ name: "Rating", count: 2 });
		// Two of the three due values are dates.
		expect(manager.getPropertyInfo("due")).toMatchObject({ type: "date", count: 3 });
		expect(manager.getPropertyInfo("tags")?.type).toBe("tags");
		expect(manager.getPropertyInfo("missing")).toBeUndefined();
	});

	test("getTypeInfo without a value answers QuickAdd with the property's type", async () => {
		const { manager } = await managerFor(NOTES, { types: { status: "multitext" } });
		expect(manager.getTypeInfo("status").expected.type).toBe("multitext");
		expect(manager.getTypeInfo("due").expected.type).toBe("date");
		// With a value: the expected widget, and the one the value has by itself.
		const info = manager.getTypeInfo("due", "soon");
		expect([info.expected.type, info.inferred.type]).toEqual(["date", "text"]);
	});

	test("tags and aliases types are offered only for their own property", async () => {
		const { manager } = await managerFor({}, undefined);
		const types = (name: string) => manager.getTypesFor(name).map((w) => w.type);
		expect(types("tags")).toContain("tags");
		expect(types("status")).not.toContain("tags");
		expect(types("status")).not.toContain("aliases");
		expect(types("status")).not.toContain("unknown");
	});

	test("an edited types.json is read again", async () => {
		const json = { types: { rating: "number" } as Record<string, string> };
		const { manager } = await managerFor(NOTES, json);
		json.types.rating = "text";
		await manager.onConfigFileChange();
		expect(manager.getAssignedType("rating")).toBe("text");
	});
});

describe("changing a property's type converts what it can", () => {
	test("text becomes a one-item list, tags split on commas and spaces", () => {
		expect(convertValue("hello world", "multitext")).toEqual(["hello world"]);
		expect(convertValue("#a, b c", "tags")).toEqual(["a", "b", "c"]);
		expect(convertValue(["a", "b"], "text")).toBe("a, b");
	});

	test("numbers, booleans and dates convert from matching text", () => {
		expect(convertValue("4.5", "number")).toBe(4.5);
		expect(convertValue("false", "checkbox")).toBe(false);
		expect(convertValue("2025-01-10T10:30:00", "date")).toBe("2025-01-10");
		expect(convertValue("10:30 2025-01-10", "datetime")).toBeUndefined();
	});

	test("a value with no faithful conversion is kept (undefined)", () => {
		expect(convertValue("high", "number")).toBeUndefined();
		expect(convertValue("soon", "date")).toBeUndefined();
		expect(convertValue({ a: 1 }, "multitext")).toBeUndefined();
		expect(convertValue(null, "number")).toBeNull();
	});
});
