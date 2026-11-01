import { expect, test } from "bun:test";
import { versionFrom } from "../scripts/version";

test("the version counts commits after the tag, rolling past 80 into the minor", () => {
	expect(versionFrom("v0.1.0", 0)).toBe("0.1.0");
	expect(versionFrom("v0.1.0", 15)).toBe("0.1.15");
	expect(versionFrom("v0.1.0", 80)).toBe("0.1.80");
	expect(versionFrom("v0.1.0", 81)).toBe("0.2.0");
	expect(versionFrom("v0.1.0", 170)).toBe("0.3.8");
	expect(versionFrom("v1.0.0", 3)).toBe("1.0.3");
});
