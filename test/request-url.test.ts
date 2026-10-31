import { describe, expect, test } from "bun:test";
import { requestHeaders, settleRequest } from "../src/api/util";

const body = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

// settleRequest turns the main process's answer into what requestUrl resolves
// or rejects with.
describe("requestUrl responses", () => {
	test("a 404 with an HTML body rejects with an Error carrying the status", () => {
		// Building the error used to read the json getter, so non-JSON bodies
		// rejected with a SyntaxError and no status.
		let err: any;
		try {
			settleRequest({ url: "https://x" }, { status: 404, headers: { "content-type": "text/html" }, body: body("<h1>Not found</h1>") });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(Error);
		expect(err.status).toBe(404);
		expect(err.headers["content-type"]).toBe("text/html");
		expect(err.text).toBe("<h1>Not found</h1>");
		expect(() => err.json).toThrow(SyntaxError);
	});

	test("throw: false resolves with the error response", () => {
		const res = settleRequest({ url: "https://x", throw: false }, { status: 500, headers: {}, body: body('{"error":"boom"}') });
		expect(res.status).toBe(500);
		expect(res.json).toEqual({ error: "boom" });
	});

	test("a request the main process could not make rejects with its reason", () => {
		expect(() => settleRequest({ url: "https://x" }, { error: "getaddrinfo ENOTFOUND x" })).toThrow("getaddrinfo ENOTFOUND x");
	});

	test("the body is decoded as UTF-8 text", () => {
		expect(settleRequest({ url: "https://x" }, { status: 200, headers: {}, body: body("π ≈ 3.14") }).text).toBe("π ≈ 3.14");
	});
});

describe("requestUrl headers", () => {
	test("contentType replaces a Content-Type in headers, whatever its case, and keeps the rest as given", () => {
		const headers = requestHeaders({ url: "https://x", contentType: "application/json", headers: { "content-type": "text/plain", "User-Agent": "git/2.0" } });
		expect(headers).toEqual({ "User-Agent": "git/2.0", "Content-Type": "application/json" });
	});
});
