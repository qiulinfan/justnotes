// T-L9 (the map): the theorem-like environments of a project (src/tex/theorems.ts, design 4.5)
// from \newtheorem, \newtheorem*, \elegantnewtheorem and elegantbook's built-in table, on
// synthetic sources and on the synthetic elegantbook fixture; the table against the installed
// elegantbook.cls (skipped without TeX or the class).
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveTexBinDir } from "../../src/latex/tex/binaries";
import { projectDefinitions } from "../../src/latex/tex/macros";
import { stripComments } from "../../src/latex/tex/project";
import { ELEGANT_NAMES, ELEGANT_SCHEMES, TheoremMap, theoremMap } from "../../src/latex/tex/theorems";

const map = (...sources: string[]) => theoremMap(sources.map(stripComments));
/** An environment as `name|numbered|spec|title|punct|prefix|role|color|qed`. */
const show = (m: TheoremMap, env: string) => {
  const d = m.get(env);
  return d ? [d.name, d.numbered ? "#" : "-", d.spec, d.title, d.punct, d.prefix ?? "", d.role ?? "", d.color ?? "", d.qed ?? ""].join("|") : null;
};

test("theoremMap follows a local class's ElegantBook inheritance and its own options", () => {
  const cls = String.raw`\ProvidesClass{notes-native}
\LoadClass[lang=cn,chinesefont=nofont]{elegantbook}
\RequirePackage[scheme=plain]{ctex}`;
  const wrapped = map(String.raw`\documentclass[lang=en,color=black]{../classes/notes-native}`, cls);
  const direct = map(String.raw`\documentclass[lang=cn,chinesefont=nofont]{elegantbook}`);
  assert.deepEqual([...wrapped], [...direct], "LoadClass doesn't implicitly forward the wrapper's options");
  assert.equal(wrapped.get("definition")!.color, "rgb(0, 166, 82)");
  assert.equal(wrapped.get("theorem")!.name, "定理");
  assert.equal(map(String.raw`\documentclass{article}`, cls).get("theorem"), undefined, "an unrelated class file is not an inheritance link");
  assert.equal(map(String.raw`\documentclass{missing}`, cls).get("definition"), undefined);
});

test("theoremMap honors literal forwarded class options and bounds inheritance cycles", () => {
  const m = map(
    String.raw`\PassOptionsToClass{color=black}{elegantbook}\documentclass[lang=cn]{outer}`,
    String.raw`\ProvidesClass{outer}\LoadClassWithOptions{inner}`,
    String.raw`\ProvidesClass{inner}\LoadClassWithOptions{elegantbook}`,
  );
  assert.equal(m.get("definition")!.name, "定义");
  assert.equal(m.get("definition")!.color, map(String.raw`\documentclass[cn,black]{elegantbook}`).get("definition")!.color);
  const localPass = map(String.raw`\documentclass{outer}`, String.raw`\ProvidesClass{outer}\PassOptionsToClass{lang=cn,color=green}{elegantbook}\LoadClass{elegantbook}`);
  assert.deepEqual([...localPass], [...map(String.raw`\documentclass[lang=cn,color=green]{elegantbook}`)]);
  const cycle = map(String.raw`\documentclass{a}`, String.raw`\ProvidesClass{a}\LoadClass{b}`, String.raw`\ProvidesClass{b}\LoadClass{a}`);
  assert.equal(cycle.size, 0);
  const conditional = map(String.raw`\documentclass{choice}`, String.raw`\ProvidesClass{choice}\iffoo\LoadClass{article}\else\LoadClass{elegantbook}\fi`);
  assert.equal(conditional.size, 0, "multiple possible base classes stay unrecognized rather than guessing a branch");
});

test("local LoadClassWithOptions chains reach the live theorem map through projectDefinitions", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-inherited-class-"));
  try {
    const root = join(dir, "main.tex");
    writeFileSync(root, String.raw`\documentclass[lang=cn,color=green]{./outer}\begin{document}\end{document}`);
    writeFileSync(join(dir, "outer.cls"), String.raw`\ProvidesClass{outer}\LoadClassWithOptions{inner}`);
    writeFileSync(join(dir, "inner.cls"), String.raw`\ProvidesClass{inner}\LoadClassWithOptions{elegantbook}`);
    const files = projectDefinitions(root).files;
    assert.ok(files.includes(join(dir, "inner.cls")));
    assert.deepEqual([...theoremMap(files.map(file => stripComments(readFileSync(file, "utf8"))))], [...map(String.raw`\documentclass[lang=cn,color=green]{elegantbook}`)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("theoremMap: \\newtheorem numbered (shared counter, within) and starred; amsthm's proof and period", () => {
  const m = map(
    "\\documentclass{article}\n\\usepackage{amsmath,amsthm}\n" +
      "\\newtheorem{thm}{Theorem}[section]\n\\newtheorem{lem}[thm]{Lemma}\n\\theoremstyle{definition}\n" +
      "\\newtheorem{defn}{{\\bfseries Definition}}\n\\newtheorem*{rem}{Remark}\n% \\newtheorem{hidden}{Hidden}",
  );
  assert.deepEqual(
    ["thm", "lem", "defn", "rem", "proof", "hidden"].map((e) => show(m, e)),
    [
      "Theorem|#|o|paren|.||||",
      "Lemma|#|o|paren|.||||",
      "Definition|#|o|paren|.||||",
      "Remark|-|o|paren|.||||",
      "Proof|-|o|replace|.||||□",
      null,
    ],
  );
  assert.ok(m.get("thm")!.user && !m.get("proof")!.user, "cleveref names the project's \\newtheorem types");
  const plain = map("\\documentclass{article}\n\\newtheorem{theorem}{Satz}");
  assert.deepEqual([show(plain, "theorem"), show(plain, "proof")], ["Satz|#|o|paren|||||", null], "LaTeX's own \\newtheorem: no period, no proof");
  assert.equal(show(map("\\documentclass{amsart}"), "proof"), "Proof|-|o|replace|.||||□", "the AMS classes load amsthm");
  assert.equal(show(map("\\documentclass{ctexart}\n\\usepackage{amsthm}"), "proof"), "证明|-|o|replace|.||||□", "ctex names it");
  assert.equal(show(map("\\documentclass{article}\n\\usepackage[scheme=plain]{ctex}\n\\usepackage{amsthm}"), "proof"), "Proof|-|o|replace|.||||□");
});

test("theoremMap: elegantbook's boxes and heads by language, mode and colour scheme", () => {
  const cn = map("\\documentclass[lang=cn,11pt,chinese]{elegantbook}");
  assert.deepEqual(
    ["theorem", "definition", "proposition", "lemma*", "example", "proof", "note", "custom", "assumption"].map((e) => show(cn, e)),
    [
      "定理|#|tcb|paren||thm|second|rgb(255, 134, 24)|",
      "定义|#|tcb|paren||def|main|rgb(0, 166, 82)|",
      "命题|#|tcb|paren||pro|third|rgb(0, 174, 247)|",
      "引理|-|tcb*|paren|||second|rgb(255, 134, 24)|",
      "例题|#|o|after|||main|rgb(0, 166, 82)|",
      "证明|-||paren|||second|rgb(255, 134, 24)|",
      "笔记|-||paren|||second|rgb(255, 134, 24)|",
      "|-|m|name|||third|rgb(0, 174, 247)|",
      "假设|-||paren|||third|rgb(0, 174, 247)|",
    ],
    "blue is the class's default scheme; elegantbook's proof has no end mark",
  );
  const green = map("\\documentclass[cn,color=green]{elegantbook}");
  assert.deepEqual([show(green, "theorem"), show(green, "definition")], ["定理|#|tcb|paren||thm|second|rgb(230, 90, 7)|", "定义|#|tcb|paren||def|main|rgb(0, 120, 2)|"]);
  assert.equal(map("\\documentclass[cyan]{elegantbook}").get("proposition")!.color, "rgb(244, 105, 102)", "a bare scheme name, English");
  assert.equal(map("\\documentclass[cyan]{elegantbook}").get("proposition")!.name, "Proposition");
  const simple = map("\\documentclass[lang=cn,simple]{elegantbook}\n\\usepackage{amsthm}");
  assert.deepEqual([show(simple, "theorem"), show(simple, "theorem*")], ["定理|#|o|paren|||second|rgb(255, 134, 24)|", "定理|-|o|paren|||second|rgb(255, 134, 24)|"], "amsthm theorems, no labels by argument");
  assert.equal(show(map("\\documentclass[mode=simple]{elegantbook}"), "proof"), "Proof|-||paren|||second|rgb(255, 134, 24)|", "elegantbook's own proof");
  assert.equal(map("\\documentclass{book}").get("theorem"), undefined, "other classes define none");
});

test("theoremMap: \\elegantnewtheorem in fancy and simple mode; later definitions win", () => {
  const src = "\\elegantnewtheorem{fact}{事实}{prostyle}{fac}\n\\elegantnewtheorem{claim}{断言}{defstyle}\n\\elegantnewtheorem{obs}{Obs}{thmstyle}{}";
  const m = map("\\documentclass[lang=cn]{elegantbook}", src);
  assert.deepEqual(
    ["fact", "fact*", "claim", "obs"].map((e) => show(m, e)),
    [
      "事实|#|tcb|paren||fac|third|rgb(0, 174, 247)|",
      "事实|-|tcb*|paren|||third|rgb(0, 174, 247)|",
      "断言|#|tcb|paren||claim|main|rgb(0, 166, 82)|",
      "Obs|#|tcb|paren||obs|second|rgb(255, 134, 24)|",
    ],
    "the prefix defaults to the environment's name",
  );
  assert.equal(show(map("\\documentclass[simple]{elegantbook}", src), "fact"), "事实|#|o|paren|||third|rgb(0, 174, 247)|");
  assert.equal(map("\\documentclass{article}", src).get("fact"), undefined, "only elegantbook defines the command");
  assert.equal(map("\\documentclass{article}", "\\newtheorem{a}{A}", "\\newtheorem{a}{B}").get("a")!.name, "B");
});

test("theoremMap: the synthetic elegantbook fixture (its sources as TexRender reads them)", () => {
  const root = resolve("test/latex/fixtures/elegantbook/main.tex");
  const m = theoremMap(projectDefinitions(root).files.map((f) => stripComments(readFileSync(f, "utf8"))));
  assert.deepEqual(
    ["theorem", "definition", "proposition", "proof"].map((e) => show(m, e)),
    [
      "定理|#|tcb|paren||thm|second|rgb(255, 134, 24)|",
      "定义|#|tcb|paren||def|main|rgb(0, 166, 82)|",
      "命题|#|tcb|paren||pro|third|rgb(0, 174, 247)|",
      "证明|-||paren|||second|rgb(255, 134, 24)|",
    ],
  );
});

test("theoremMap: the counters that print chapter.n (numbering boxes without a label)", () => {
  const counters = (m: TheoremMap, envs: string[]) => envs.map((e) => m.get(e)?.counter ?? null);
  const fancy = map("\\documentclass[lang=cn]{elegantbook}", "\\elegantnewtheorem{fact}{事实}{prostyle}{fac}[theorem]\n\\elegantnewtheorem{obs}{Obs}{thmstyle}");
  assert.deepEqual(
    counters(fancy, ["theorem", "theorem*", "definition", "example", "exercise", "problem", "note", "fact", "obs"]),
    ["tcb@cnt@theorem", null, "tcb@cnt@definition", "exam", "exer", "prob", null, "tcb@cnt@theorem", "tcb@cnt@obs"],
    "tcolorbox's auto counter, [shared] its `use counter from`; example, exercise and problem their own",
  );
  assert.deepEqual(counters(map("\\documentclass[simple]{elegantbook}"), ["theorem", "lemma"]), ["theorem", "lemma"], "amsthm's, within chapter");
  assert.deepEqual(counters(map("\\documentclass[usesamecnt]{elegantbook}"), ["theorem", "definition", "example"]), ["ELEGANT@samecnt", "ELEGANT@samecnt", "exam"]);
  assert.deepEqual(counters(map("\\documentclass[thmcnt=section]{elegantbook}"), ["theorem", "example"]), [null, "exam"], "section.n: no chapter count");
  assert.deepEqual(counters(map("\\documentclass[section]{elegantbook}"), ["theorem"]), [null]);
  const ams = map("\\documentclass{book}\n\\usepackage{amsthm}\n\\newtheorem{thm}{Theorem}[chapter]\n\\newtheorem{lem}[thm]{Lemma}\n\\newtheorem{sec}{S}[section]\n\\newtheorem{run}{R}\n\\newtheorem{eqs}[equation]{E}");
  assert.deepEqual(counters(ams, ["thm", "lem", "sec", "run", "eqs"]), ["thm", "thm", null, null, null], "within chapter or sharing such a counter only");
});

const binDir = process.env.TEXBIN ?? resolveTexBinDir("");
const cls = binDir ? spawnSync(join(binDir, "kpsewhich"), ["elegantbook.cls"], { encoding: "utf8" }).stdout.trim() : "";

test("theoremMap: the table is the installed elegantbook.cls's (schemes, names, prefixes, styles)", { skip: cls ? false : "no elegantbook.cls" }, () => {
  const text = readFileSync(cls, "utf8");
  // \ifdefstring{\ELEGANT@color}{green}{ \definecolor{main}{RGB}{0,120,2} ... }
  for (const [scheme, [main, second, third]] of Object.entries(ELEGANT_SCHEMES)) {
    const block = new RegExp(String.raw`\\ifdefstring\{\\ELEGANT@color\}\{${scheme}\}\{([^]*?)\}\{\\relax\}`).exec(text)?.[1] ?? "";
    const rgb = (name: string) => new RegExp(String.raw`\\definecolor\{${name}\}\{RGB\}\{(\d+),(\d+),(\d+)\}`).exec(block)?.slice(1).map(Number);
    assert.deepEqual([rgb("main"), rgb("second"), rgb("third")], [main, second, third], scheme);
  }
  assert.match(text, /\\DeclareStringOption\[blue\]\{color\}/, "blue by default");
  for (const lang of ["cn", "en"] as const) {
    const blocks = text.matchAll(new RegExp(String.raw`\\ifdefstring\{\\ELEGANT@lang\}\{${lang}\}\{([^]*?)\n\}\{\\relax\}`, "g"));
    const block = [...blocks].map((b) => b[1]).join("\n");
    for (const [env, name] of Object.entries(ELEGANT_NAMES[lang])) {
      assert.match(block, new RegExp(String.raw`\\(?:re)?newcommand\*?\{\\${env}name\}\{${name}\}`), `${lang} ${env}`);
    }
  }
  // \ELEGANT@newtheorem{theorem}{thm}{thmstyle} (fancy mode)
  const m = map("\\documentclass{elegantbook}");
  const roles: Record<string, string> = { defstyle: "main", thmstyle: "second", prostyle: "third" };
  const boxes = [...text.matchAll(/^\s*\\ELEGANT@newtheorem\{(\w+)\}\{(\w+)\}\{(\w+)\}$/gm)];
  assert.equal(boxes.length, 7);
  for (const [, env, prefix, style] of boxes) assert.deepEqual([m.get(env)?.prefix, m.get(env)?.role], [prefix, roles[style]], env);
});
