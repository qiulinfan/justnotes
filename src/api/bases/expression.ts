// The Bases formula language: a hand-written tokenizer and Pratt parser. Filters
// and formulas share it. Nothing here evaluates code with eval or Function.
import { BooleanValue, NullValue, NumberValue, StringValue, type Value } from "./values";

export type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "+" | "-" | "*" | "/" | "%";

export type Node =
	| { kind: "literal"; value: Value }
	| { kind: "regexp"; source: string; flags: string }
	| { kind: "ident"; name: string }
	| { kind: "member"; object: Node; name: string }
	| { kind: "index"; object: Node; index: Node }
	| { kind: "call"; callee: Node; args: Node[] }
	| { kind: "unary"; op: "!" | "-"; arg: Node }
	| { kind: "binary"; op: BinaryOp; left: Node; right: Node }
	| { kind: "list"; items: Node[] }
	| { kind: "object"; entries: [string, Node][] };

type Token =
	| { t: "num"; v: number; pos: number }
	| { t: "str"; v: string; pos: number }
	| { t: "ident"; v: string; pos: number }
	| { t: "op"; v: string; pos: number }
	| { t: "regexp"; source: string; flags: string; pos: number }
	| { t: "eof"; pos: number };

export class ParseError extends Error {
	pos: number;

	constructor(message: string, pos: number) {
		super(message);
		this.pos = pos;
	}
}

// Lowest to highest: || < && < == != < comparisons < + - < * / %. Unary ! and -
// bind tighter, and member access, calls and indexing tighter still.
const BINARY: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
const UNARY = 7;
const OPERATORS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", "{", "}", ",", ".", ":"];
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	// A `/` starts a regular expression unless it follows an operand.
	const afterOperand = () => {
		const last = tokens[tokens.length - 1];
		if (!last) return false;
		if (last.t === "op") return last.v === ")" || last.v === "]" || last.v === "}";
		return true;
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const rest = src.slice(i);
		const num = NUMBER.exec(rest);
		if (num && !(c === "." && afterOperand())) {
			tokens.push({ t: "num", v: Number(num[0]), pos: i });
			i += num[0].length;
			continue;
		}
		if (c === '"' || c === "'") {
			let value = "";
			let j = i + 1;
			for (; j < src.length && src[j] !== c; j++) {
				if (src[j] !== "\\") {
					value += src[j];
					continue;
				}
				const e = src[++j];
				if (e === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 1, j + 5))) {
					value += String.fromCharCode(Number.parseInt(src.slice(j + 1, j + 5), 16));
					j += 4;
				} else value += ESCAPES[e] ?? e ?? "";
			}
			if (j >= src.length) throw new ParseError("Unterminated string", i);
			tokens.push({ t: "str", v: value, pos: i });
			i = j + 1;
			continue;
		}
		const ident = IDENT.exec(rest);
		if (ident) {
			tokens.push({ t: "ident", v: ident[0], pos: i });
			i += ident[0].length;
			continue;
		}
		if (c === "/" && !afterOperand()) {
			let j = i + 1;
			let inClass = false;
			for (; j < src.length; j++) {
				const ch = src[j];
				if (ch === "\\") j++;
				else if (ch === "[") inClass = true;
				else if (ch === "]") inClass = false;
				else if (ch === "/" && !inClass) break;
			}
			if (j >= src.length) throw new ParseError("Unterminated regular expression", i);
			const flags = /^[a-z]*/.exec(src.slice(j + 1))![0];
			tokens.push({ t: "regexp", source: src.slice(i + 1, j), flags, pos: i });
			i = j + 1 + flags.length;
			continue;
		}
		const op = OPERATORS.find((o) => rest.startsWith(o));
		if (!op) throw new ParseError(`Unexpected character "${c}"`, i);
		tokens.push({ t: "op", v: op === "===" ? "==" : op === "!==" ? "!=" : op, pos: i });
		i += op.length;
	}
	tokens.push({ t: "eof", pos: src.length });
	return tokens;
}

class Parser {
	#tokens: Token[];
	#i = 0;

	constructor(src: string) {
		this.#tokens = tokenize(src);
	}

	parse(): Node {
		const node = this.#expr(0);
		const end = this.#peek();
		if (end.t !== "eof") throw new ParseError(`Unexpected ${describe(end)}`, end.pos);
		return node;
	}

	#peek() {
		return this.#tokens[this.#i];
	}

	#next() {
		return this.#tokens[this.#i++] ?? this.#tokens[this.#tokens.length - 1];
	}

	#isOp(v: string) {
		const tok = this.#peek();
		return tok.t === "op" && tok.v === v;
	}

	#expect(v: string) {
		const tok = this.#next();
		if (tok.t !== "op" || tok.v !== v) throw new ParseError(`Expected "${v}" but found ${describe(tok)}`, tok.pos);
	}

	#expr(minBp: number): Node {
		let left = this.#prefix();
		for (;;) {
			const tok = this.#peek();
			if (tok.t !== "op") break;
			if (tok.v === "." || tok.v === "(" || tok.v === "[") {
				left = this.#postfix(left);
				continue;
			}
			const bp = BINARY[tok.v];
			if (!bp || bp <= minBp) break;
			this.#next();
			left = { kind: "binary", op: tok.v as BinaryOp, left, right: this.#expr(bp) };
		}
		return left;
	}

	#prefix(): Node {
		const tok = this.#next();
		switch (tok.t) {
			case "num":
				return { kind: "literal", value: new NumberValue(tok.v) };
			case "str":
				return { kind: "literal", value: new StringValue(tok.v) };
			case "regexp":
				try {
					new RegExp(tok.source, tok.flags);
				} catch (err) {
					throw new ParseError(`Invalid regular expression: ${(err as Error).message}`, tok.pos);
				}
				return { kind: "regexp", source: tok.source, flags: tok.flags };
			case "ident":
				if (tok.v === "true" || tok.v === "false") return { kind: "literal", value: new BooleanValue(tok.v === "true") };
				if (tok.v === "null") return { kind: "literal", value: NullValue.value };
				return { kind: "ident", name: tok.v };
			case "op":
				if (tok.v === "(") {
					const inner = this.#expr(0);
					this.#expect(")");
					return inner;
				}
				if (tok.v === "[") return { kind: "list", items: this.#list("]") };
				if (tok.v === "{") return this.#object();
				if (tok.v === "!" || tok.v === "-") return { kind: "unary", op: tok.v, arg: this.#expr(UNARY) };
				if (tok.v === "+") return this.#expr(UNARY);
		}
		throw new ParseError(`Unexpected ${describe(tok)}`, tok.pos);
	}

	#postfix(object: Node): Node {
		const tok = this.#next();
		if (tok.t === "op" && tok.v === "(") return { kind: "call", callee: object, args: this.#list(")") };
		if (tok.t === "op" && tok.v === "[") {
			const index = this.#expr(0);
			this.#expect("]");
			return { kind: "index", object, index };
		}
		const name = this.#next();
		if (name.t !== "ident") throw new ParseError(`Expected a property name but found ${describe(name)}`, name.pos);
		return { kind: "member", object, name: name.v };
	}

	// Comma-separated expressions up to `close`; a trailing comma is allowed.
	#list(close: string): Node[] {
		const items: Node[] = [];
		while (!this.#isOp(close)) {
			items.push(this.#expr(0));
			if (!this.#isOp(close)) this.#expect(",");
		}
		this.#next();
		return items;
	}

	#object(): Node {
		const entries: [string, Node][] = [];
		while (!this.#isOp("}")) {
			const key = this.#next();
			if (key.t !== "ident" && key.t !== "str") throw new ParseError(`Expected a key but found ${describe(key)}`, key.pos);
			this.#expect(":");
			entries.push([key.v, this.#expr(0)]);
			if (!this.#isOp("}")) this.#expect(",");
		}
		this.#next();
		return { kind: "object", entries };
	}
}

function describe(tok: Token) {
	switch (tok.t) {
		case "eof":
			return "end of formula";
		case "num":
			return `number ${tok.v}`;
		case "str":
			return "string";
		case "regexp":
			return "regular expression";
		default:
			return `"${tok.v}"`;
	}
}

export type ParseResult = { node: Node; error: null } | { node: null; error: string };

// Bases re-evaluates the same filter and formula strings for every row, so
// each string is parsed once.
const cache = new Map<string, ParseResult>();

export function parseExpression(src: string): ParseResult {
	let result = cache.get(src);
	if (result) return result;
	try {
		result = { node: new Parser(src).parse(), error: null };
	} catch (err) {
		if (!(err instanceof ParseError)) throw err;
		result = { node: null, error: `${err.message} (at ${err.pos + 1})` };
	}
	if (cache.size > 5000) cache.clear();
	cache.set(src, result);
	return result;
}
