# justnotes development

justnotes is an Electron Markdown editor that hosts Obsidian community plugins.
It reimplements the `obsidian` module from scratch; never copy or unpack code
from Obsidian's `app.asar`.

The owner's goal: a local note tool with Live Preview, local search, and (not
built yet) one-way upload of the vault to a cloud drive for restoring on a new
device. No accounts, no sync service, no database: the files are the data and
everything else is derived in memory at startup.

## README

README.md is for human readers and carries the owner's own words. Do not add
agent-written prose, marketing, or rationale there. Keep only its factual parts
(how to run, what works, what does not) current with each change, in the same
plain style. Development notes belong in this file.

## Layout

- `src/main/main.ts`: Electron main process. One window per vault, Node
  integration on, because plugins `require("fs")`, `child_process` and
  `electron` directly.
- `src/api/`: the `obsidian` module. `index.ts` is the export list plugins see.
  `dom.ts` installs Obsidian's prototype and global augmentations (`createEl`,
  `addClass`, `Array.prototype.remove`, `sleep`, ...); it must run before any
  plugin code.
- `src/api/plugins.ts`: evaluates `.obsidian/plugins/<id>/main.js` with a
  `require` that returns this `obsidian` module and the host's own CodeMirror
  and Lezer modules. Plugins must share the editor's CodeMirror instances.
- `src/api/markdown-view.ts`: the editor (CodeMirror 6), `src/api/live-preview.ts`
  the Live Preview decorations and the `$`/`$$` math grammar.
- `src/renderer/`: host UI (boot, file explorer, search, command palette, quick
  switcher) and `app.css`, which keeps Obsidian's CSS variable and class names
  so plugin stylesheets apply.

## Compatibility rules

- Signatures: `node_modules/obsidian/obsidian.d.ts`. Plugins also use private
  API; read the plugin's bundled `main.js` to see exactly what it touches and
  match that behavior instead of guessing. A quick inventory:
  `grep -oE "require\(['\"][^'\"]+['\"]\)"` for modules and
  `grep -oE 'app\.[a-zA-Z]+(\.[a-zA-Z]+)?'` for app members.
- Keyboard: a capture-phase `keydown` listener walks the keymap scope stack
  before CodeMirror sees the key. The root scope has one catch-all handler that
  runs command hotkeys; plugins may replace it (Completr clears
  `app.scope.keys` and installs its own, relying on `hotkeyManager.bake()`,
  `bakedHotkeys`, `bakedIds`, `defaultKeys` and `commands.findCommand`).
  Baked modifiers and `KeymapContext.modifiers` must use the same canonical
  string (`Alt,Ctrl,Meta,Shift` order, `Mod` resolved to the platform key).
- The vault's `.obsidian/hotkeys.json` overrides plugin defaults. Check it
  before deciding a key "does not work": the owner binds Completr's insert to
  Tab, so Enter correctly inserts a newline there.
- Editor suggests: never close a suggest because the document changed without
  typing. Completr inserts its completion with `replaceRange` and then reads
  `this.context`; closing on that change nulls the context mid-call. Retrigger
  suggests in a microtask after the update, only for `input.type`/`delete`
  events or selection moves while one is open. Completr also reads
  `suggestions.values`, `selectedItem`, `setSelectedItem`, `useSelectedItem`
  and `suggestions.containerEl`.
- `Editor` methods tag a transaction with a user event only when the caller
  passes an origin; untagged edits must not look like typing.
- `Plugin.load()` awaits an async `onload` before children load and before the
  next plugin, as Obsidian does. `Component.load()` stays synchronous.
- `registerCodeMirror` is a no-op: it only ran in Obsidian's legacy editor.
  Quick LaTeX registers both and works through its CM6 extension.
- Never write Obsidian's own config files (`workspace.json`,
  `community-plugins.json`, `app.json`, `hotkeys.json`). justnotes state lives
  in localStorage via `app.saveLocalStorage`.

## Live Preview and math

- Decorations are one `StateField` rebuilt from the whole syntax tree on every
  doc, selection or tree change. Block math needs a state field (view plugins
  cannot replace line breaks). Fine for notes of a few thousand lines; restrict
  to visible ranges if large files get slow.
- Reveal rule: inline syntax shows while any selection touches the element;
  line syntax (heading marks, quote marks, list bullets, tasks, rules, block
  math) shows while the selection is on those lines.
- Math nodes are `InlineMath` and `BlockMath` from `mathSyntax`. Obsidian's own
  parser uses HyperMD-style node and class names (`cm-math`, `HyperMD-header-N`,
  `HyperMD-quote`, `HyperMD-codeblock`); line classes follow those names, but a
  plugin that walks Obsidian's syntax tree by node name (likely latex-live) will
  need the names checked against what it expects.
- `Tag.define(parent)` throws if the parent is a modified tag such as
  `tags.special(x)`; it kills the renderer before boot.
- MathJax 3 (`mathjax/es5/tex-svg-full.js`, copied to `dist/mathjax`) renders
  SVG with a local font cache. Its `svgStylesheet()` must be in the document,
  or the assistive MathML copy renders beside every formula.
- Enter on an empty `>` line steps out one quote level (Typora behavior); the
  owner named CodeMirror's continue-the-quote default as a pain point.

## Plugin status

Verified: copy-location, quick-latex, obsidian-completr (LaTeX completion,
snippet placeholders), yolo (loads, settings render; Tab completion not tried
because it calls a paid API).

Not yet adapted, with what each needs beyond the current API:

| Plugin | Needs |
|---|---|
| omp-sidebar | `electron`, `child_process`, `readline`; an `ItemView` that runs `omp` |
| kgdistiller | `node:fs/promises`; mostly public API |
| background | Obsidian DOM structure and CSS for per-surface wallpapers |
| latex-live | Live Preview node names, `MarkdownRenderer`, `loadMathJax`, `loadPdfJs`, `loadPrism`, `TextFileView`, `child_process`, `electron` |
| obsidian-git | `Menu`, `SuggestModal`s, `SettingPage`, diff views, `editorLivePreviewField`, `child_process` |
| quickadd | `app.internalPlugins` (templates, daily notes), `app.plugins.plugins`, `app.dom`, many components |
| terminal | xterm in an `ItemView`, `child_process` pty, `addIcon`/`removeIcon` |

## Verify

- `bun run check` (TypeScript) and `bun run build`.
- Test against a copy of a vault, never the owner's real vaults: plugins write
  their `data.json`, and some (obsidian-git, kgdistiller, terminal, omp-sidebar)
  run external programs. Trim the copy's `community-plugins.json` to the
  plugins under test.
- Launch `./node_modules/.bin/electron . --vault <copy> --remote-debugging-port=9333`
  and drive it with `scripts/cdp.ts`: real key events (plugins listen to
  keydown), `eval` against `window.app`, screenshots, and `reload` to catch
  boot errors (a renderer exception before boot leaves `app` undefined).
