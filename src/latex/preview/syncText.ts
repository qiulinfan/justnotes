import type { PdfBox } from "../tex/synctex";
import { sourceTokens } from "../editor/reveal";

// Forward SyncTeX, corrected by the PDF's text. `synctex view` names the boxes of a source line,
// and the preview takes the first. In a paragraph that box can sit a line off (TeX breaks the
// paragraph after reading it), and in beamer a frame's first lines can be recorded on the page
// before (the frame's body is read as an argument, then typeset) and an overlay's lines on a
// page where they are still covered. The words of the cursor's line, looked for in the text of
// the pages around SyncTeX's page, place the box; a line not found keeps SyncTeX's box.

/** Pages searched on each side of SyncTeX's page. */
export const PAGE_REACH = 2;
/** PDF words a source line may skip or gain (hyphenation, macros' own words). */
const SLACK = 4;
const MAX_SOURCE_WORDS = 64;
/** Total LCS cells per reveal; exhausting the budget keeps the native SyncTeX result. */
const MATCH_BUDGET = 2_000_000;

/** A run of PDF text, in points from the page's top-left corner. */
export interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageText {
  page: number;
  runs: TextRun[];
}

const WORD = /[\p{L}\p{N}]+/gu;
const PIECE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

/**
 * Lower-cased words, CJK text one character each (its runs split differently in source and PDF).
 * Numbers and words under three letters are dropped: math (`x_t^2`), TikZ coordinates and
 * table specs are made of them, and they match anywhere.
 */
function words(text: string): string[] {
  return [...text.normalize("NFKC").toLowerCase().matchAll(WORD)]
    .flatMap(([w]) => w.match(PIECE) ?? [])
    .filter((w) => CJK.test(w) || (w.length >= 3 && /\p{L}/u.test(w)));
}

/** A bounded source context around the cursor, lower-cased with CJK split. */
export function lineWords(line: string, column = 0): string[] {
  const tokens = sourceTokens(line).flatMap((token) =>
    [...token.text.matchAll(PIECE)].flatMap((part) =>
      words(part[0]).map((word) => ({ word, from: token.from + part.index })),
    ),
  );
  const next = tokens.findIndex((token) => token.from >= column);
  const center = next < 0 ? tokens.length : next;
  const start = Math.max(0, Math.min(tokens.length - MAX_SOURCE_WORDS, center - MAX_SOURCE_WORDS / 2));
  return tokens.slice(start, start + MAX_SOURCE_WORDS).map((token) => token.word);
}

/** Matched pairs of the longest common subsequence of `a` and `b`, as indexes into `b`. */
function common(a: string[], b: string[]): number[] {
  const n = a.length, m = b.length;
  const len = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  }
  const hit: number[] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) { hit.push(j); i++; j++; }
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return hit;
}

/**
 * Where the source line's `line` words are in `pages`, or null. A place is a stretch of a page's
 * words that holds most of them in order (at least half, and two when the line has two); the
 * most words wins. Among equals SyncTeX's page keeps its place nearest SyncTeX's box; otherwise
 * the page nearest SyncTeX's (an overlay's line first shows there), the later one at equal
 * distance (beamer's error is the page before). The box covers the PDF runs of the matched words.
 */
export function placeLine(pages: PageText[], line: string[], box: PdfBox): PdfBox | null {
  if (!line.length || line.length > MAX_SOURCE_WORDS) return null;
  const need = Math.max(Math.min(2, line.length), Math.ceil(line.length / 2));
  const set = new Set(line);
  let best: { score: number; rank: number; box: PdfBox } | null = null;
  let remaining = MATCH_BUDGET;
  for (const { page, runs } of pages) {
    const toks: { w: string; run: number }[] = [];
    runs.forEach((r, run) => { for (const w of words(r.str)) toks.push({ w, run }); });
    const all = toks.map((t) => t.w);
    for (let i = 0; i < toks.length; i++) {
      if (!set.has(all[i])) continue;
      const end = Math.min(all.length, i + line.length + SLACK);
      remaining -= line.length * (end - i);
      if (remaining < 0) return null;
      const hit = common(line, all.slice(i, end)).map((j) => i + j);
      if (hit.length < need) continue;
      const used = [...new Set(hit.map((j) => toks[j].run))].map((r) => runs[r]);
      const x = Math.min(...used.map((r) => r.x)), y = Math.min(...used.map((r) => r.y));
      const place = {
        page, x, y,
        width: Math.max(...used.map((r) => r.x + r.width)) - x,
        height: Math.max(...used.map((r) => r.y + r.height)) - y,
      };
      // Lower is better: SyncTeX's page by distance to its box, then other pages by distance.
      const rank = page === box.page ? Math.abs(y - box.y) / 1e6 : Math.abs(page - box.page) + (page > box.page ? 0 : 0.5);
      if (!best || hit.length > best.score || (hit.length === best.score && rank < best.rank)) best = { score: hit.length, rank, box: place };
    }
  }
  return best?.box ?? null;
}
