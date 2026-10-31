import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { resolveTexBinDir, texEnv, texTool } from "../../src/latex/tex/binaries";

test("an explicit TeX bin directory is authoritative and an invalid one does not fall back", () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-bin-"));
  try {
    writeFileSync(join(dir, process.platform === "win32" ? "pdflatex.exe" : "pdflatex"), "fixture");
    assert.equal(resolveTexBinDir(` ${dir} `), dir);
    assert.equal(resolveTexBinDir(join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TeX discovery follows PATH order before machine-wide installation candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "latex-live-path-"));
  const previous = process.env.PATH;
  try {
    const first = join(root, "selected"), second = join(root, "other");
    for (const dir of [first, second]) {
      mkdirSync(dir);
      writeFileSync(join(dir, process.platform === "win32" ? "pdflatex.exe" : "pdflatex"), "fixture");
    }
    process.env.PATH = [first, second].join(delimiter);
    assert.equal(resolveTexBinDir(""), first);
    process.env.PATH = [second, first].join(delimiter);
    assert.equal(resolveTexBinDir(""), second);
    assert.equal(texEnv(first).PATH, [first, second, first].join(delimiter));
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Windows TeX drops inherited POSIX-only locales while POSIX and user locales stay intact", () => {
  const keys = ["LANG", "LC_ALL", "LC_CTYPE"];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.LANG = "C.UTF-8";
    process.env.LC_ALL = "C.utf8";
    process.env.LC_CTYPE = "en-US.utf8";
    const env = texEnv("selected-bin");
    assert.equal(env.LANG, process.platform === "win32" ? undefined : "C.UTF-8");
    assert.equal(env.LC_ALL, process.platform === "win32" ? undefined : "C.utf8");
    assert.equal(env.LC_CTYPE, "en-US.utf8", "an explicit native/user locale is not rewritten");
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});

const installed = resolveTexBinDir(process.env.TEXBIN ?? "");
test("the installed latexmk starts without an inherited POSIX-locale warning", {
  skip: !installed || !existsSync(texTool(installed, "latexmk")),
}, () => {
  // Start from the same inherited host values the boundary is meant to handle.
  const keys = ["LANG", "LC_ALL", "LC_CTYPE"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "C.UTF-8";
    const result = spawnSync(texTool(installed!, "latexmk"), ["-v"], {
      env: texEnv(installed!), encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Setting locale failed|Falling back to the system default locale/);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});
