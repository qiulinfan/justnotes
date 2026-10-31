import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { undo } from "@codemirror/commands";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { texEditorExtensions } from "../../src/latex/editor/texExtensions";
import { SuiteConfig, SuiteMode, SuiteSnippet, snippetTemplate, suitePlace } from "../../src/latex/editor/suiteSnippets";

// A string/visual snippet as LaTeX Suite 1.14 builds it, for the fields suiteSnippets reads:
// options from the option letters, `process` on the document prefix plus the key, `$n` and
// `${n:text}` tab stops, `${VISUAL}`.
function snip(trigger: string, replacement: string, letters: string): SuiteSnippet {
  const has = (c: string) => letters.includes(c);
  const own = { text: has("t"), inlineMath: has("m") || has("n"), blockMath: has("m") || has("M") };
  const visual = replacement.includes("${VISUAL}");
  return {
    type: visual ? "visual" : "string",
    options: {
      automatic: has("A"),
      onWordBoundary: has("w"),
      snippetShouldRunInMode(mode: SuiteMode) {
        if (mode.snippetlessEnv) return false;
        if (((own.inlineMath && mode.inlineMath) || (own.blockMath && mode.blockMath)) && !mode.textEnv) return true;
        return own.text && mode.text;
      },
    },
    process({ effectiveLine, range, sel }) {
      if (visual) {
        if (!sel.original || !effectiveLine.endsWith(trigger)) return null;
        return { triggerPos: range.original.from, replacement: tabbed(replacement.replace("${VISUAL}", sel.original)) };
      }
      if (!effectiveLine.endsWith(trigger)) return null;
      return { triggerPos: effectiveLine.length - trigger.length, replacement: tabbed(replacement) };
    },
  };
}

function tabbed(src: string) {
  const tabstops: { index: number[]; from: number; to: number }[] = [];
  let insert = "";
  const re = /\$(\d+)|\$\{(\d+):([^}]*)\}/g;
  let at = 0;
  for (let m; (m = re.exec(src)); ) {
    insert += src.slice(at, m.index);
    const text = m[3] ?? "";
    tabstops.push({ index: [Number(m[1] ?? m[2])], from: insert.length, to: insert.length + text.length });
    insert += text;
    at = m.index + m[0].length;
  }
  return { insert: insert + src.slice(at), tabstops };
}

const SNIPPETS = [
  snip("mk", "$$0$", "tA"),
  snip("dm", "\\[\n$0\n\\]", "tAw"),
  snip("@a", "\\alpha", "mA"),
  snip("ali", "\\alpha ", "mA"),
  snip("in", "\\in", "mAw"),
  snip("fr", "\\frac{$0}{$1}$2", "mA"),
  snip("lr{", "\\left\\{ $0 \\right\\}", "mA"),
  snip("sr", "^{2}", "m"),
  snip("U", "\\underbrace{ ${VISUAL} }_{ $0 }", "mA"),
];

function config(o: Partial<SuiteConfig> = {}): SuiteConfig {
  return {
    snippets: SNIPPETS,
    trigger: " ",
    wordDelimiters: "., +-\\n\t:;!?\\/{}[]()=~$",
    removeWhitespace: true,
    suppressOnIME: true,
    recursion: 0,
    textMacros: [{ name: "text", arguments: [0], kind: "text" }, { name: "tag", arguments: [0], kind: "restricted" }],
    ...o,
  };
}

function setup(doc: string, cfg: SuiteConfig | null = config()) {
  const parent = document.body.appendChild(document.createElement("div"));
  const at = doc.indexOf("|");
  const text = at < 0 ? doc : doc.slice(0, at) + doc.slice(at + 1);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      selection: { anchor: at < 0 ? text.length : at },
      extensions: texEditorExtensions({ text, snippets: () => cfg }),
    }),
  });
  view.focus();
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

/** Types like the browser: the input handlers first, else a plain insert. */
function type(view: EditorView, chars: string) {
  for (const ch of chars) {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: "input.type" });
    if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
  }
}

function press(view: EditorView, key: string) {
  const ev = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "keyCode", { get: () => ({ Tab: 9 } as Record<string, number>)[key] });
  view.contentDOM.dispatchEvent(ev);
}

/** The document with `|` at the cursor (or `[..]` around the selection). */
function shown(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const d = view.state.doc.toString();
  return from === to ? d.slice(0, from) + "|" + d.slice(to) : d.slice(0, from) + "[" + d.slice(from, to) + "]" + d.slice(to);
}

test("suitePlace: text, inline and display math, environments, \\text{}, comments, empty formulas", () => {
  const at = (src: string) => {
    const i = src.indexOf("|");
    return suitePlace(Text.of((src.slice(0, i) + src.slice(i + 1)).split("\n")), i, config().textMacros);
  };
  assert.equal(at("a |b").mode.text, true);
  assert.equal(at("a $x|$ b").mode.inlineMath, true);
  assert.equal(at("a $x$| b").mode.text, true, "after the closing $");
  assert.equal(at("a |$x$ b").mode.text, true, "before the opening $");
  assert.equal(at("a $|$ b").mode.inlineMath, true, "empty, right after mk");
  assert.equal(at("\\[|\\]").mode.blockMath, true);
  assert.equal(at("$$|$$").mode.blockMath, true);
  assert.equal(at("\\(x|\\)").mode.inlineMath, true);
  const env = at("\\begin{align*}\n  a &= |b\n\\end{align*}");
  assert.equal(env.mode.blockMath, true);
  assert.equal(env.env, "align*");
  assert.equal(at("\\begin{align*}|\na\n\\end{align*}").mode.blockMath, true);
  assert.equal(at("\\begin{al|ign*}\na\n\\end{align*}").mode.text, true, "in the environment's name");
  const t = at("$a \\text{ if |} b$");
  assert.deepEqual([t.mode.inlineMath, t.mode.textEnv], [true, true]);
  assert.equal(at("$\\text{a} |$").mode.textEnv, false, "after the argument");
  assert.equal(at("$\\text{a $x|$}$").mode.textEnv, true, "LaTeX Live's formula is the outer one");
  assert.equal(at("$\\tag{|}$").mode.snippetlessEnv, true);
  assert.equal(at("$\\frac{\\text{a}}{|}$").mode.textEnv, false);
  const c = at("x % $a|$").mode;
  assert.deepEqual([c.text, c.inlineMath], [false, false], "in a comment");
  assert.equal(at("x \\% $a|$").mode.inlineMath, true, "an escaped percent sign");
});

test("mk makes inline math, @a becomes \\alpha there only", () => {
  const { view, done } = setup("Let |");
  type(view, "mk");
  assert.equal(shown(view), "Let $|$");
  type(view, "@a");
  assert.equal(shown(view), "Let $\\alpha|$");
  type(view, "+x");
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(view, " see @a");
  assert.equal(shown(view), "Let $\\alpha+x$ see @a|", "text mode leaves @a alone");
  done();
});

test("undo takes back the expansion only, and the next keys are their own step", () => {
  const { view, done } = setup("|");
  type(view, "mk");
  type(view, "x");
  assert.equal(shown(view), "$x|$");
  undo(view);
  assert.equal(view.state.doc.toString(), "$$");
  undo(view);
  assert.equal(view.state.doc.toString(), "m");
  done();
});

test("the space trigger runs non-automatic snippets and is swallowed; elsewhere space types", () => {
  const { view, done } = setup("$x|$");
  type(view, "sr ");
  assert.equal(shown(view), "$x^{2}|$");
  type(view, " ");
  assert.equal(shown(view), "$x^{2} |$");
  done();
  const t = setup("x|");
  type(t.view, "sr ");
  assert.equal(shown(t.view), "xsr |");
  t.done();
});

test("word boundary, trailing whitespace in inline math, multi-line replacement", () => {
  const { view, done } = setup("$x|$");
  type(view, "in");
  assert.equal(shown(view), "$xin|$", "no delimiter before");
  type(view, " in");
  assert.equal(shown(view), "$xin \\in|$");
  done();
  const w = setup("$|$");
  type(w.view, "ali");
  assert.equal(shown(w.view), "$\\alpha|$", "trimmed in inline math");
  w.done();
  const d = setup("\\[|\\]");
  type(d.view, "ali");
  assert.equal(shown(d.view), "\\[\\alpha |\\]", "kept in display math");
  d.done();
  const m = setup("  a |");
  type(m.view, "dm");
  assert.equal(shown(m.view), "  a \\[\n  |\n  \\]", "lines after the first take the line's indent");
  m.done();
});

test("tab stops are keyArbiter's snippet fields; LaTeX braces survive the template", () => {
  const { view, done } = setup("$|$");
  type(view, "fr");
  assert.equal(shown(view), "$\\frac{|}{}$");
  type(view, "a");
  press(view, "Tab");
  assert.equal(shown(view), "$\\frac{a}{|}$");
  type(view, "b");
  press(view, "Tab");
  assert.equal(shown(view), "$\\frac{a}{b}|$");
  done();
  const l = setup("$|$");
  type(l.view, "lr{");
  assert.equal(shown(l.view), "$\\left\\{ | \\right\\}$");
  l.done();
});

test("visual snippets wrap the selection", () => {
  const { view, done } = setup("$a+b$");
  view.dispatch({ selection: { anchor: 1, head: 4 } });
  type(view, "U");
  assert.equal(shown(view), "$\\underbrace{ a+b }_{ | }$");
  done();
});

test("\\text{} in math and comments do not expand; no config, no snippets", () => {
  const { view, done } = setup("$\\text{|}$");
  type(view, "@a");
  assert.equal(shown(view), "$\\text{@a|}$");
  done();
  const c = setup("% |");
  type(c.view, "mk");
  assert.equal(shown(c.view), "% mk|");
  c.done();
  const off = setup("|", null);
  type(off.view, "mk");
  assert.equal(shown(off.view), "mk|");
  off.done();
});

test("a Tab trigger expands through keyArbiter's tabFallback, else indents", () => {
  const { view, done } = setup("$x|$", config({ trigger: "Tab" }));
  type(view, "sr");
  press(view, "Tab");
  assert.equal(shown(view), "$x^{2}|$");
  type(view, " ");
  assert.equal(shown(view), "$x^{2} |$");
  done();
});

test("snippets preserve verbatim environments, inline code and skipped comments", () => {
  const sources = [
    "\\begin{verbatim}\n|\n\\end{verbatim}",
    "\\begin{lstlisting}\n|\n\\end{lstlisting}",
    "\\begin{minted}{latex}\n|\n\\end{minted}",
    "\\begin{verbatim}\n|",
    "\\verb!|!",
    "\\verb!|",
    "\\lstinline[language=TeX]{|}",
    "\\lstinline[language=TeX]{|",
    "\\mintinline{latex}!|!",
    "\\mintinline[fontsize=\\small]{latex}!|!",
    "\\iffalse\n|\n\\fi",
    "\\begin{comment}\n|\n\\end{comment}",
  ];
  for (const source of sources) {
    const { view, done } = setup(source);
    const at = source.indexOf("|");
    const expected = source.slice(0, at) + "mk|" + source.slice(at + 1);
    try { type(view, "mk"); assert.equal(shown(view), expected, source); }
    finally { done(); }
  }
  for (const source of [
    "\\verb!example!|",
    "\\mintinline[fontsize=\\small]{latex}!example!|",
    "\\newcommand{\\example}{\\begin{verbatim}}\n|",
    "\\verb!\\begin{verbatim}! |",
    "Here |% comment",
  ]) {
    const outside = setup(source);
    try { type(outside.view, "mk"); assert.equal(shown(outside.view), source.replace("|", "$|$")); }
    finally { outside.done(); }
  }
});

test("snippetTemplate: order, linked stops, escapes", () => {
  assert.equal(snippetTemplate("\\frac{}{}", [{ index: [1], from: 8, to: 8 }, { index: [0], from: 6, to: 6 }]), "\\frac{${1}}{${2}}");
  assert.equal(snippetTemplate("x", []), "x${1}");
  assert.equal(snippetTemplate("a b a", [{ index: [0], from: 0, to: 1 }, { index: [0], from: 4, to: 5 }]), "${1:a} b ${1:a}");
  assert.equal(snippetTemplate("\\{ \\}", [{ index: [0], from: 3, to: 3 }]), "\\\\{ ${1}\\\\}");
  assert.equal(snippetTemplate("${x}", [{ index: [0], from: 4, to: 4 }]), "$\\{x}${1}");
  assert.equal(snippetTemplate("\\sqrt{a}", [{ index: [0], from: 0, to: 8 }]), "${1}\\sqrt{a}", "braces in a placeholder");
});
