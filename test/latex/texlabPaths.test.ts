import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { EditorState } from "@codemirror/state";
import { resolveTexlab, texlabSettings, TexlabServer } from "../../src/latex/lsp/texlab";

test("texlab output directories are file URLs, including reserved URL characters", () => {
  const output = join(tmpdir(), "latex build # 中文 %", "output");
  assert.deepEqual(texlabSettings(output).build, {
    auxDirectory: pathToFileURL(output).href,
    pdfDirectory: pathToFileURL(output).href,
  });
});

const binary = process.env.TEXLAB_BIN || resolveTexlab("");
test("native texlab survives an absolute output directory on Windows (issue #2)",
  { skip: !binary && "texlab is not installed", timeout: 20000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "latex-path-"));
    const output = join(root, "build # 中文 %");
    mkdirSync(output);
    const file = join(root, "main.tex");
    const text = "\\documentclass{article}\n\\begin{document}\n\\fr\n\\end{document}\n";
    writeFileSync(file, text);
    const doc = EditorState.create({ doc: text }).doc;
    const statuses: string[] = [];
    const server = new TexlabServer({ binary: () => binary, root, env: () => process.env,
      settings: () => texlabSettings(output), onStatus: (status) => statuses.push(status) });
    try {
      server.open(file, doc);
      const result = await server.completion(file, doc, { line: 2, character: 3 }, { triggerKind: 1 });
      assert.equal(server.status, "running");
      const items = Array.isArray(result) ? result : (result as { items?: { label: string }[] } | null)?.items;
      assert.ok(items?.some((item: { label: string }) => item.label === "frac"), "real texlab returns frac");
      // The configuration response can be processed after the first completion.
      // Give dependency discovery time to run, then exercise the same process again.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await server.hover(file, doc, { line: 0, character: 5 });
      assert.equal(server.status, "running");
      assert.equal(statuses.includes("failed"), false, "texlab must not crash and restart");
    } finally {
      await server.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
