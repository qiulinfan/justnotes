import * as nodePath from "node:path";

// Finding links in terminal output. URLs are xterm's web-links addon's; these
// are the file paths a line names (`ls` output, compiler errors, `git status`),
// which become links when they reach a file in the vault.

export interface PathCandidate {
	// UTF-16 offsets into the line, end exclusive.
	start: number;
	end: number;
	path: string;
	line?: number;
	column?: number;
}

// Runs of characters that may make up a path: no whitespace, quotes,
// brackets, or the separators of `a:b` lists.
const TOKEN = /[^\s'"`()[\]{}<>|;,]+/g;
// A trailing `:line` or `:line:column`, as compilers print.
const POSITION = /:(\d+)(?::(\d+))?:?$/;
// Ends of a token that are punctuation, not part of the name.
const TRAILING = /[.,:;!?]+$/;

// The tokens of a line that look like paths: they have a separator or end in
// a file extension, and are no URL.
export function findPathCandidates(line: string): PathCandidate[] {
	const found: PathCandidate[] = [];
	for (const m of line.matchAll(TOKEN)) {
		let text = m[0];
		const start = m.index ?? 0;
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith("-")) continue;
		let lineNo: number | undefined;
		let column: number | undefined;
		const pos = POSITION.exec(text);
		if (pos) {
			lineNo = Number(pos[1]);
			column = pos[2] ? Number(pos[2]) : undefined;
		}
		let path = pos ? text.slice(0, pos.index) : text;
		path = path.replace(TRAILING, "");
		if (!pos) text = path;
		if (!path || path === "." || path === ".." || path === "~") continue;
		const hasSeparator = path.includes("/") || path.includes("\\");
		const hasExtension = /[^.]\.[\p{L}\p{N}_]{1,12}$/u.test(path);
		if (!hasSeparator && !hasExtension) continue;
		found.push({ start, end: start + text.length, path, line: lineNo, column });
	}
	return found;
}

// The vault-relative path a candidate names from `cwd`, or null when it is
// outside the vault. `~` is the home folder.
export function vaultPathOf(candidate: string, cwd: string, vaultRoot: string, home: string): string | null {
	let absolute: string;
	if (candidate === "~" || candidate.startsWith("~/")) absolute = nodePath.join(home, candidate.slice(1));
	else absolute = nodePath.resolve(cwd, candidate);
	const rel = nodePath.relative(vaultRoot, absolute);
	if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
	return rel.split(nodePath.sep).join("/");
}

// A path as typed into a shell: bare when it is plain, else quoted.
export function shellQuote(path: string, platform: string = process.platform) {
	if (/^[\w@%+=:,./-]+$/.test(path)) return path;
	if (platform === "win32") return `"${path.replace(/"/g, '""')}"`;
	return `'${path.replace(/'/g, "'\\''")}'`;
}

// The folder an OSC 7 report (`file://host/path`) names, or null.
export function osc7Path(data: string): string | null {
	try {
		const url = new URL(data);
		if (url.protocol !== "file:") return null;
		const path = decodeURIComponent(url.pathname);
		// file:///C:/x on Windows.
		return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
	} catch {
		return null;
	}
}
