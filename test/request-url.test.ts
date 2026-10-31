import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { type RawResponse, settleRequest } from "../src/api/util";
import { requestHeaders, requestUrl } from "../src/main/ipc";

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
	test("contentType replaces a Content-Type in any case; User-Agent and Accept are added only when missing", () => {
		const given = requestHeaders({ contentType: "application/json", headers: { "content-type": "text/plain", "user-agent": "git/2.0" } }, "app/1.0");
		expect(given).toEqual({ "user-agent": "git/2.0", "Content-Type": "application/json", Accept: "*/*" });
		expect(requestHeaders({ headers: {} }, "app/1.0")).toEqual({ "User-Agent": "app/1.0", Accept: "*/*" });
	});
});

// The main process side: what servers receive and what the renderer gets back.
describe("requestUrl transport", () => {
	const servers: http.Server[] = [];
	const origins: string[] = [];

	// Echoes the request; /gzip answers gzip-encoded with two cookies; /redirect/<status>?to=<url>
	// redirects.
	const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://x");
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const redirect = /^\/redirect\/(\d+)$/.exec(url.pathname);
			if (redirect) {
				res.writeHead(Number(redirect[1]), { Location: url.searchParams.get("to") ?? "/" });
				res.end();
			} else if (url.pathname === "/gzip") {
				res.setHeader("Content-Encoding", "gzip");
				res.setHeader("Set-Cookie", ["a=1", "b=2"]);
				res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
			} else {
				const headers: Record<string, string> = {};
				for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
				res.end(JSON.stringify({ method: req.method, headers, body: Buffer.concat(chunks).toString() }));
			}
		});
	};

	beforeAll(async () => {
		for (let i = 0; i < 2; i++) {
			const server = http.createServer(handle);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			servers.push(server);
			origins.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
		}
	});

	afterAll(() => {
		for (const server of servers) {
			server.closeAllConnections();
			server.close();
		}
	});

	const text = (raw: RawResponse) => {
		if ("error" in raw) throw new Error(raw.error);
		return new TextDecoder().decode(raw.body);
	};

	test("the plugin's headers reach the server exactly as given, with nothing browser-like added", async () => {
		// Node's fetch sent sec-fetch-mode: cors over the plugin's own value, plus
		// accept-language: * and User-Agent "node".
		const raw = await requestUrl(
			{
				url: `${origins[0]}/echo`,
				method: "GET",
				headers: { "User-Agent": "git/2.47", "Sec-Fetch-Mode": "navigate", "Accept-Encoding": "identity", Cookie: "session=1" },
				body: "q",
			},
			"app/1.0",
		);
		const echo = JSON.parse(text(raw));
		expect(echo.method).toBe("GET");
		expect(echo.body).toBe("q");
		const added = Object.keys(echo.headers).filter((name) => name !== "host" && name !== "connection");
		expect(added.sort()).toEqual(["accept", "accept-encoding", "content-length", "cookie", "sec-fetch-mode", "user-agent"]);
		expect(echo.headers["sec-fetch-mode"]).toBe("navigate");
		expect(echo.headers["user-agent"]).toBe("git/2.47");
	});

	test("a gzip body is decoded, and repeated headers come back joined under lower-case names", async () => {
		const raw = await requestUrl({ url: `${origins[0]}/gzip`, method: "GET", headers: { "Accept-Encoding": "gzip" } }, "app/1.0");
		expect(JSON.parse(text(raw))).toEqual({ zipped: true });
		if ("error" in raw) return;
		expect(raw.headers["set-cookie"]).toBe("a=1, b=2");
		expect(raw.headers["content-encoding"]).toBe("gzip");
	});

	test("a 303 continues as a GET without the body or credentials elsewhere; a 307 repeats the request", async () => {
		const target = `${origins[1]}/echo`;
		const post = { method: "POST", contentType: "text/plain", body: "payload", headers: { Authorization: "Bearer t" } };
		const seeOther = JSON.parse(text(await requestUrl({ ...post, url: `${origins[0]}/redirect/303?to=${encodeURIComponent(target)}` }, "app/1.0")));
		expect(seeOther.method).toBe("GET");
		expect(seeOther.body).toBe("");
		expect(seeOther.headers.authorization).toBeUndefined();
		expect(seeOther.headers["content-type"]).toBeUndefined();
		const temporary = JSON.parse(text(await requestUrl({ ...post, url: `${origins[0]}/redirect/307?to=%2Fecho` }, "app/1.0")));
		expect(temporary.method).toBe("POST");
		expect(temporary.body).toBe("payload");
		expect(temporary.headers.authorization).toBe("Bearer t");
	});

	test("a request that cannot be made resolves with the reason instead of rejecting", async () => {
		const server = http.createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		await new Promise((resolve) => server.close(resolve));
		const raw = await requestUrl({ url: `http://127.0.0.1:${port}/`, method: "GET", headers: {} }, "app/1.0");
		expect("error" in raw && raw.error).toContain("ECONNREFUSED");
	});
});
