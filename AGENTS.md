# justnotes development

justnotes is an Electron Markdown editor that hosts Obsidian community plugins.
It reimplements the `obsidian` module from scratch; never copy or unpack code
from Obsidian's `app.asar`. The references are the public typings
(`node_modules/obsidian/obsidian.d.ts`) and docs.obsidian.md.

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

- `src/main/`: the Electron main process. `main.ts` opens one window per vault
  (Node integration on, context isolation off, `webviewTag`,
  `@electron/remote`), owns the external-link policy and routes `obsidian://`
  URLs to the vault window. `lifecycle.ts` runs the quit flush
  (`justnotes:before-close` / `justnotes:close-ready`), `ipc.ts` the
  synchronous IPC behind SecretStorage (Electron `safeStorage`) and the
  plugins' clipboard, `protocol.ts` scheme registration.
- `src/api/`: the `obsidian` module. `index.ts` is exactly the list plugins see:
  the value exports of `obsidian.d.ts`, no more (`test/finish-exports.test.ts`
  checks both directions). Modules that also hold justnotes internals are listed
  name by name there; app code imports internals from their own modules, never
  from `./index`.
  - `dom.ts` installs Obsidian's prototype and global augmentations (`createEl`,
    `addClass`, `Array.prototype.remove`, `sleep`, `window.moment`, ...) before
    any plugin code; `getElectron()` adds `remote` and a synchronous
    `clipboard` to the `electron` module.
  - `plugins.ts` evaluates `.obsidian/plugins/<id>/main.js` with a `require`
    that returns this module and the host's own CodeMirror, Lezer and
    `@codemirror/collab` modules; plugins must share the editor's instances.
  - `app.ts` (App, CustomCss, RenderContext, `obsidian://` handling),
    `workspace.ts` (leaf tree, tabs, splits, side docks, placeholders, page
    preview, history), `view.ts` (View, ItemView, FileView, TextFileView),
    `markdown-view.ts` (editing and reading halves of MarkdownView),
    `markdown-preview.ts` (reading view), `markdown.ts` (MarkdownRenderer, post
    processors, code-block registry, the math grammar, MathJax/pdf.js/Prism/
    Mermaid loaders), `live-preview.ts` and `editor-*.ts` (CodeMirror 6),
    `vault.ts`, `metadata*.ts`, `file-manager.ts`, `keymap.ts`,
    `internal-plugins.ts`, `secret-storage.ts`, `sanitize.ts` (DOMPurify),
    `setting-modal.ts`, `ui/` (menus, modals, notices, settings, suggests,
    tooltips), `bases/` (Bases: formulas, queries, table/cards/list views).
- `src/renderer/`: host UI (boot, core commands, file explorer, search, view
  and workspace commands, bases view, the core plugins in `core-plugins.ts`
  and the modules it installs) and `styles/NN-*.css`, which keep
  Obsidian's CSS variable and class names so plugin stylesheets apply.

## Compatibility rules

- Signatures come from `obsidian.d.ts`. Plugins also use private API; read the
  plugin's bundled `main.js` to see exactly what it touches and match that
  behavior instead of guessing. A quick inventory:
  `grep -oE "require\(['\"][^'\"]+['\"]\)"` for modules and
  `grep -oE 'app\.[a-zA-Z]+(\.[a-zA-Z]+)?'` for app members.
- Boot order: `vault.load`, the metadata index (started early, awaited), then
  `internalPlugins.initialize` and `installCorePlugins`, then
  `plugins.initialize`, then the layout restore and `layout-ready`. Plugins
  see a resolved cache and the core plugins' options in `onload`, as in
  Obsidian, and so miss the first `resolved` event.
- Core plugins follow the vault's `core-plugins.json` and read their options
  from `<configDir>/<id>.json`, never writing either: their settings are set in
  Obsidian. Enabled instances exist only for those `IMPLEMENTED` in
  `internal-plugins.ts`; a disabled one adds no commands, ribbon button or
  pane. Their commands keep Obsidian's ids (`backlink:open`,
  `outgoing-links:open`, `outline:open`, `daily-notes`,
  `daily-notes:goto-prev`/`-next`, `insert-template`,
  `insert-current-date`/`-time`), so `hotkeys.json` binds them. The panes'
  views (`backlink`, `outgoing-link`, `outline`) register always, so a saved
  layout keeps them; they follow the active file. Unlinked mentions are
  computed only while their section is open, by reading every note
  (`findMentions`: whole words ignoring case, a name next to a Chinese or
  Japanese character counts, links, frontmatter and code blocks skipped).
  Templates insert a template's frontmatter at the top, adding only the
  properties the note lacks. Not there yet: backlinks at the bottom of a note,
  the outline's search and cursor following, the other core plugins (graph,
  canvas, note composer, tag pane, file recovery, ...).
- Keyboard: a capture-phase `keydown` listener walks the keymap scope stack
  before CodeMirror sees the key; the active scope follows keyboard focus. The
  root scope has one catch-all handler that runs command hotkeys; plugins may
  replace it (Completr clears `app.scope.keys` and installs its own, relying on
  `hotkeyManager.bake()`, `bakedHotkeys`, `bakedIds`, `defaultKeys` and
  `commands.findCommand`). Baked modifiers and `KeymapContext.modifiers` use
  one canonical string (`Alt,Ctrl,Meta,Shift` order, `Mod` resolved to the
  platform key). A modal's scope has no parent, so while a modal is open only
  its own keys run; popover suggests and views fall through to the app scope.
  Editor commands never run in reading view or for a key typed in another text
  field (reading `window.event` when a plugin such as Completr passes none).
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
- A code-block language has one handler, the latest registration, in both
  views. Live Preview re-renders when processors change; the reading view keeps
  what it rendered until it re-renders.
- External links: renderer code opens a URL with `window.open(url, "_blank")`,
  never `shell.openExternal`. Main applies one policy to window opens,
  navigations and the openExternal permission requests of every session
  (`<webview>` partitions included): `obsidian:` goes to the vault window (a
  guest's to its embedder's); `file:`, `javascript:`, `data:`, `blob:`,
  `about:` and browser schemes are dropped; every other scheme goes to the
  system, as in Obsidian.
- `obsidian://open?path=` into another vault opens (or focuses) that vault's
  window, but only for vaults opened before with `--vault` or the folder
  picker (recorded in the profile's `vaults.json`): a link must never load an
  unknown folder's plugins.
- The macOS application menu keeps the standard roles (Edit, zoom, developer
  tools, window) but no accelerator on a key the renderer's hotkeys use: menu
  key equivalents fire before the page sees the key, so Electron's default
  menu made Cmd+W close the window and Cmd+R reload. Cmd+M is Quick LaTeX's.
  Windows and Linux have no menu.
- `require("electron").clipboard` is Obsidian's synchronous clipboard
  (latex-live's paste-as-table reads `readText` and `readHTML` in one go,
  `obsidian://new?clipboard` reads text). Electron 45's renderer has none and
  main's is asynchronous (promises, `read`/`write` of MIME-typed items), so
  `dom.ts` serves `readText`, `writeText`, `readHTML`, `writeHTML`,
  `readImage`, `writeImage`, `availableFormats`, `has` and `clear` over
  `sendSync` to `main/ipc.ts`.
- `Events.offref` ignores a missing ref: obsidian-git turns features off
  before turning them on, offref-ing refs it never created.
- The editor menu opens on gutter right-clicks too (obsidian-git's line author
  menu); CodeMirror's `domEventHandlers` bind to the content DOM only.
- An imperative `SettingTab`'s container belongs to the tab: the host never
  empties it before `display()` or in `hide()` (obsidian-plugin-library's
  AdvancedSettingTab, used by terminal, builds its widgets once in `onLoad`).
  Declarative tabs are emptied by their own renderer.
- The desktop adapter exposes `fs`, `fsPromises`, `path` and `url`, as
  Obsidian's does (terminal reads `adapter.fs`).
- Never write Obsidian's own config files (`workspace.json`,
  `community-plugins.json`, `app.json`, `appearance.json`, `hotkeys.json`,
  `core-plugins.json`). justnotes state lives in localStorage through
  `app.saveLocalStorage` (keys prefixed with the vault id): `justnotes-layout`
  (the layout, in `workspace.json`'s shape, with leaf ids), `enabled-plugins`
  (the Settings toggles, applied over `community-plugins.json`), `custom-css`
  (theme and snippets), `justnotes-expanded` (explorer folders). The language
  is localStorage `language`, else `en`; never the OS locale.

## Views, files and saving

- TextFileView saves through `vault.process`, so reading, merging and writing
  are one step and a plugin's concurrent write is merged, not lost. An outside
  change to an open file merges line by line with unsaved edits (`mergeText`,
  a line diff3), including lines one side added next to a line the other side
  changed; a real conflict keeps both versions and shows a notice. The take-in
  during a save, the reload on vault `modify` and the quit flush all merge
  this way.
- For a second after a save the document remembers the text the save replaced
  (`prior`), for QuickAdd's capture, which reads, computes and then writes:
  merged against the save, it would undo it. `mergeBase` merges a change
  against the replaced text only when the change is that text with lines
  inserted (an inserted line may fill a blank one), merges with the save's
  edits without a conflict, is no version the document has had (`seen`: every
  text it loaded, saved or took in) and was not made from the saved text
  (holding all its lines: QuickAdd reading after the autosave, a line appended
  without a final newline). Every other change, a revert to any version the
  document has had included, is merged against the saved text and wins. The
  comment on `mergeBase` has the exact rules.
- Limits of judging by content: a revert to a version from before the note was
  opened, landing within the second, passes for a capture when the replaced
  text is that version with lines removed or emptied, and the save's edits
  survive it. A rewrite of only lines the save inserted (a formatter tidying
  the line just typed) is byte for byte a capture, so the typed line is kept
  beside its rewrite once; the write that saves it records no `prior`
  (`keptCapture`), so a writer that rewrites on every save does not grow the
  note. After a save that only removed the final newline, a line appended
  within the second loses its own. QuickAdd's inline insert, which writes
  inside a line, still loses a racing save.
- Vault writes go in place, never to a temp file renamed over the note: a
  rename resets the birth time (Bases `file.ctime`), the inode, the mode and
  xattrs such as Finder tags. A read of a path waits for a write putting that
  file's bytes on disk; reads never wait for queued writes, because code inside
  the write queue (kgdistiller's reconcile hooks) may read.
- The adapter keeps a folder-to-children index that only its add and drop
  paths update. Changes under `.obsidian` emit only vault `raw` events, as in
  Obsidian.
- The reading view renders through `MarkdownPreviewRenderer`: one `div.el-*`
  per top-level block, re-rendering only sections whose text changed. Task
  checkboxes edit the editor document and save the view. Scroll positions are
  source lines mapped through the sections.
- Fence names Prism knows under another name use its grammar, case-insensitively
  (`c++`, `c#`, `console`, `make`, `objective-c`, `proto`). `cmd` fences stay
  plain: the owner's hold Unix shell commands, not batch.
- Heading and block links resolve with `resolveSubpath`. Page preview renders
  `![[linktext]]` as an embed: hover in the reading view, Mod-hover in Live
  Preview.
- The layout restores from localStorage; leaves of view types nobody has
  registered yet become placeholders that keep their state and turn into the
  real view when a plugin registers the type. There are no popout windows:
  `getLeaf("window")` opens a tab, shows it and makes it the active leaf
  without moving keyboard focus, as a new window would.
- Resize drags end on `lostpointercapture`, and `body.is-resizing` turns off
  pointer events in `<webview>` and `<iframe>` guests, which would otherwise
  swallow the moves and the pointerup (omp-sidebar's webview).
- Before the window closes, main asks the renderer to save open views, the
  layout and plugins' quit tasks, and waits for the reply.

## Live Preview and math

- Decorations are one `StateField` rebuilt from the syntax tree on doc,
  selection or tree changes. Block math needs a state field (view plugins
  cannot replace line breaks). Typing on a 5500-line note stays within a frame.
- Reveal rule: inline syntax shows while any selection touches the element;
  line syntax (heading marks, quote marks, list bullets, tasks, rules, block
  math) shows while the selection is on those lines.
- `editorLivePreviewField` false means Source mode: no decorations at all.
- Callouts, tables, embeds and plugin code blocks render with the reading
  view's `MarkdownRenderer`, each widget owning a Component (unloaded when
  CodeMirror destroys it) and a ResizeObserver that asks CodeMirror to
  re-measure. Rendered HTML inside the editor needs `white-space: normal`. A
  mousedown inside a widget that must act in place needs `preventDefault`, or
  the caret lands beside the widget and reveals the source.
- The math grammar is defined once in `markdown.ts` and shared by the renderer
  and Live Preview (Pandoc rule for `$`: no space after the opening one, no
  space before or digit after the closing one; a `$$` line opens a block that
  the next `$$` line closes).
- Math nodes are `InlineMath` and `BlockMath`; line classes follow Obsidian's
  HyperMD names (`cm-math`, `HyperMD-header-N`, `HyperMD-quote`,
  `HyperMD-codeblock`), built-in node names stay lezer's.
- `Tag.define(parent)` throws if the parent is a modified tag such as
  `tags.special(x)`; it kills the renderer before boot.
- MathJax 3 is Obsidian's CHTML build (`tex-chtml-full.js` with its woff
  fonts, copied to `dist/`), loaded on demand; `finishRenderMath` flushes its
  stylesheet. latex-live depends on this build and its internals.
- Enter on an empty `>` line steps out one quote level (Typora behavior); the
  owner named CodeMirror's continue-the-quote default as a pain point. Below a
  line of quote text it first writes a blank line at the outer level, or the
  next typed line would be a CommonMark lazy continuation and stay in the
  quote. Leaving the last level keeps the indentation of a list item the quote
  is in. Only a line inside a real quote counts (the syntax tree reaches a
  `Blockquote` before any text block): a `>` line in code, HTML, math or
  frontmatter gets a plain newline. Inside a fence lang-markdown's Enter never
  continues quote or list markup, so a new line in a quoted fence gets no `> `.
- Only heading sections (`foldHeading`) and what is nested in list items
  (`foldIndent`) fold, as in Obsidian: `markdownSupport` strips lang-markdown's
  block folds and the folds of every language it mounts: fenced code
  (`foldless`), HTML in notes and in `html`/`xhtml` fences (elements, script
  and style contents, `style` and event-handler attribute values), and
  `markdown` fences (CommonMark without lang-markdown's folds, so their
  headings are no sections). Vue, Angular, PHP, Liquid and Jinja fences still
  fold the code nested in them.
- Scripts and styles in a note's HTML parse by their type or lang exactly as
  lang-html decides, at once: `editor-extensions.ts` copies lang-html's
  nesting rules with fold-free parsers, including its private list of event
  handlers (from 6.4.12; recheck it when upgrading lang-html). Other types,
  such as `math/tex`, stay text. Fences match language-data by name or alias,
  not extension: `md` and `htm` fences stay plain.

## CSS

- Plugin and theme stylesheets use Obsidian's documented CSS variables
  (font weights, `--layer-*`, sizes, `--color-*-rgb` channels, `--link-*`,
  ...). A missing variable makes the whole declaration invalid at
  computed-value time, which silently drops backgrounds and z-indexes.
  `00-base.css` defines the documented set (values from docs.obsidian.md); a
  few undocumented ones are mapped to justnotes' look.
- Links take their colours from the `--link-*` variables, and a base `a` rule
  gives plain anchors in plugin views the link colour. Live Preview's link
  marks carry `.internal-link` and `.external-link`, so the reading view's link
  rules style them too.
- Host overlays sit on the same `--layer-*` scale as Obsidian's (status bar,
  popover, modal, notice, menu and suggestion, tooltip). Each `.cm-editor`
  isolates its stacking, so CodeMirror's own panel (300) and tooltip (500)
  z-indexes stay under host overlays.
- CodeMirror's base theme is the first `<style>` in `<head>`, and its light
  rules use two classes (`.ͼ2 .cm-panels`); justnotes never sets
  `EditorView.darkTheme`. Panel colours (the find panel included) are set by
  `.cm-editor .cm-…` rules, which match that weight and win by order.
- The Live Preview quote bar is a `border-inline-start` with a
  `padding-inline-start` indent, on selectors no more specific than needed, so
  plugin rules of equal specificity loaded later can undo it (obsidian-git's
  conflict markers).
- Plugin `<style>` elements go after `app.css` and before the theme and
  snippets.

## Plugin status

All of the owner's plugins load and their features were tested live on vault
copies: copy-location, quick-latex, obsidian-completr, yolo (live completion,
paid: only within the owner's small test budget), background, kgdistiller
(0.1.5 and 3.0.2), latex-live (0.2.0; 0.1.7 loads), obsidian-git, omp-sidebar,
quickadd and terminal. Known gaps: popout windows, a canvas view (QuickAdd's
capture into the active canvas), a CLI transport for `registerCliHandler`,
`app.metadataTypeManager`, editable properties, tab drag and drop.

## Verify

- `bun run check` (TypeScript), `bun run build`, `bun run test`.
- Test against a copy of a vault, never the owner's real vaults:
  `bun scripts/test-vault.ts <vault> <dest> [plugin-id ...]`. Plugins write
  their `data.json`, and some run external programs. The copy holds no link
  that points outside it: a plugin folder can be a symlink to the plugin's
  development checkout, whose `data.json` is the real one, and the script
  copies such a folder as files.
- `bun scripts/smoke.ts --vault <copy> --port <port> --profile <dir> [--keep]`
  launches an isolated instance (own profile, mock keychain, no background
  throttling) and reports boot errors; drive a kept one with
  `CDP_PORT=<port> bun scripts/cdp.ts` (real key events, `eval` against
  `window.app`, screenshots, `reload`; always set `CDP_PORT`, or it drives
  whatever listens on 9333; with two windows it attaches to the first page
  target). Mouse input goes through `Input.dispatchMouseEvent`. Injected keys
  never trigger macOS menu key equivalents, so Cmd+A needs `cdp.ts selectall`;
  native `<select>` popups cannot be driven.
- Stub openers before clicking anything that may open a URL. Assigning
  `require("@electron/remote").shell.openExternal` patches only the renderer
  proxy; evaluate in main instead (`remote.require("vm").runInThisContext`
  with `process.mainModule.require("electron")`). Stubs in main survive
  `cdp.ts reload`; the page's do not.
- Never touch the system clipboard: intercept `navigator.clipboard` in the
  page and replace main's clipboard with one in Electron 45's asynchronous
  shape. A synchronous stub in the page hides failures of the synchronous
  clipboard plugins get.
- Plugins with outside effects need a sandbox in the copy: kgdistiller 3.0.2
  gets a disposable `knowledgeHome` (and `KGDISTILLER_HOME`) and no model
  providers; omp-sidebar gets an `ompPath` wrapper that sets
  `OMP_GUI_RUNTIME_DIR` to a temp folder and adds `--port 0`, or it attaches to
  the owner's running omp server; obsidian-git gets `git init`, a local bare
  remote, `GIT_CONFIG_GLOBAL` pointing at an empty file and
  `GIT_CONFIG_NOSYSTEM=1`; quickadd keeps online features off; terminal shells
  are the owner's login shell, so launch with `fish_private_mode=1` and type
  nothing that should not run; latex-live keeps shell escape off and builds in
  the system temp folder.
