import { describe, expect, test } from "bun:test";
import { microphoneRequest } from "../src/main/media";

// Which getUserMedia requests main grants: the Audio recorder's microphone in
// the vault page, never a camera, a <webview> guest or an iframe in the page.
describe("microphoneRequest", () => {
	test("the vault page's own microphone request is granted", () => {
		expect(microphoneRequest(true, true, ["audio"])).toBe(true);
	});

	test("a webview guest, an iframe of the page, a camera or an empty request is refused", () => {
		expect(microphoneRequest(false, true, ["audio"])).toBe(false);
		expect(microphoneRequest(true, false, ["audio"])).toBe(false);
		expect(microphoneRequest(true, true, ["audio", "video"])).toBe(false);
		expect(microphoneRequest(true, true, ["video"])).toBe(false);
		expect(microphoneRequest(true, true, [])).toBe(false);
	});
});
