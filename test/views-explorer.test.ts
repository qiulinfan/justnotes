import { describe, expect, test } from "bun:test";
import { retargetFolders } from "../src/renderer/views";

// The explorer remembers open folders by path (localStorage
// justnotes-expanded); a renamed folder must stay open, with the folders
// open inside it, and a deleted one must not be remembered.
describe("retargetFolders", () => {
	const open = ["folder", "folder/sub", "folder-b", "other/folder"];

	test("a renamed folder and the folders in it stay open under the new path", () => {
		expect([...retargetFolders(open, "folder", "moved/renamed")].sort()).toEqual(["folder-b", "moved/renamed", "moved/renamed/sub", "other/folder"]);
	});

	test("a deleted folder and the folders in it are forgotten", () => {
		expect([...retargetFolders(open, "folder", null)].sort()).toEqual(["folder-b", "other/folder"]);
	});
});
