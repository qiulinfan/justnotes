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
  `@electron/remote`), owns the external-link policy (`link-policy.ts` has
  the schemes it drops) and routes `obsidian://` URLs to the vault window.
  The only `window.open` it lets through as a window
  is a popout's (`popout.ts`: `about:blank` under the `justnotes-popout`
  frame name). `lifecycle.ts` runs the quit flush
  (`justnotes:before-close` / `justnotes:close-ready`), `ipc.ts` the
  synchronous IPC behind SecretStorage (Electron `safeStorage`) and the
  plugins' clipboard, `protocol.ts` scheme registration, `media.ts` which
  media requests are granted.
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
    preview, history, tab drag and drop, popout windows; `popout-window.ts`
    opens and styles their documents), `view.ts` (View, ItemView, FileView,
    TextFileView),
    `markdown-view.ts` (editing and reading halves of MarkdownView),
    `markdown-preview.ts` (reading view), `markdown.ts` (MarkdownRenderer, post
    processors, code-block registry, the math grammar, MathJax/pdf.js/Prism/
    Mermaid loaders), `live-preview.ts` and `editor-*.ts` (CodeMirror 6),
    `vault.ts`, `metadata*.ts` (the cache; `metadata-types.ts`, the
    `metadataTypeManager`; `metadata-editor.ts` and `metadata-widgets.ts`,
    the Properties block), `frontmatter-edit.ts`, `file-manager.ts`, `keymap.ts`,
    `internal-plugins.ts`, `secret-storage.ts`, `sanitize.ts` (DOMPurify),
    `setting-modal.ts`, `ui/` (menus, modals, notices, settings, suggests,
    tooltips), `bases/` (Bases: formulas, queries, table/cards/list views).
- `src/cli/`: the `justnotes` command (see Command line below):
  `justnotes.ts` (the command, run with `bun run cli -- ...` or as the
  package's bin), `protocol.ts` (the socket), `args.ts` (Obsidian's syntax),
  `spec.ts` (the built-in command table: names, flags, where each runs, help),
  `commands/vault.ts` and `commands/app.ts` (the built-ins), `run.ts`,
  `output.ts` (results and formats), `offline.ts` (a vault read without the
  app), `vaults.ts` (which vault a command means, shared with main),
  `completion.ts` (the shell scripts) and `complete.ts` (their candidates).
  `src/main/cli.ts` and `cli-server.ts` serve the socket,
  `src/renderer/cli.ts` runs a request in the vault window.
- `packaging/`: what the packaged app adds (see Packaging and releases): the
  icon (`icon.svg`, rendered to `icon.png`) and the command's launchers.
  `electron-builder.yml` is the packaging configuration.
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
- Core plugins follow the vault's `core-plugins.json`, with the Core plugins
  settings page's toggles applied over it (localStorage `enabled-core-plugins`,
  `{enabled, disabled}` like the community overlay), and read their options
  from `<configDir>/<id>.json`, never writing either: their settings are set in
  Obsidian. Enabled instances exist only for those `IMPLEMENTED` in
  `internal-plugins.ts`; a disabled one adds no commands, ribbon button or
  pane. Each implemented plugin has an installer (`installers()` in
  `core-plugins.ts`, signature `(app, host)`) that registers everything through
  its `CorePluginHost` (`addCommand`, `addEditorCommand`, `addRibbonIcon`,
  `addStatusBarItem`, `registerView`, `registerEvent`, `register`, ...), so a
  toggle takes effect live: `disable()` unloads the host, `enable()` runs the
  installer again (`host.userEnabled` is true then: panes join the sidebar,
  Daily notes skips its autorun). Never register a core plugin's feature on
  `app` directly, or turning it off leaves it behind. Pane plugins close
  their leaves when turned off; views registered through the host become
  placeholders. Files and Search are shown always on. Their commands keep Obsidian's ids (`backlink:open`,
  `backlink:toggle-backlinks`, `outgoing-links:open`, `outline:open`,
  `graph:open`, `graph:open-local`, `tag-pane:open`, `daily-notes`, `daily-notes:goto-prev`/`-next`,
  `insert-template`, `insert-current-date`/`-time`,
  `note-composer:merge-file`/`split-file`/`extract-heading`,
  `file-recovery:open`, `slides:start`, `audio-recorder:start`/`stop`), so `hotkeys.json` binds them. The panes' views
  (`backlink`, `outgoing-link`, `outline`, `tag`, `graph`, `localgraph`)
  register always, so a saved
  layout keeps them; the first three follow the active file. Unlinked mentions
  are computed only while their section is open, by reading every note
  (`findMentions`: whole words ignoring case, a name next to a Chinese or
  Japanese character counts, links, frontmatter and code blocks skipped).
  Backlinks under a note (`BacklinkList`, shared with the pane) start from
  backlink.json's `backlinkInDocument` and then follow the leaf's `backlinks`
  state; the backlink instance's `createEmbeddedBacklinks` makes them, and
  `MarkdownView` puts them in a CodeMirror block widget after the last line
  (`MarkdownEditView.setFooter`) or in the reading view's `.mod-footer`. The
  outline marks the heading the editor's cursor (the reading view's top line)
  is under and filters by its search box. The Tags view counts notes per tag
  (case-insensitive, nested tags count the notes of their subtree) and
  searches `tag:#x` on click. Note composer reads note-composer.json
  (`askBeforeMerging`, `replacementText` link/embed/none, `template` with
  `{{content}}`, `{{fromTitle}}`, `{{newTitle}}`, `{{date:...}}`): Enter adds
  at the end, Shift+Enter at the start (after the frontmatter), Mod+Enter (or
  Enter with no match) creates a note named as typed; a merged note's
  frontmatter adds only missing properties, links to it are redirected
  (`FileManager.redirectLinks`) and it goes to the trash. File recovery keeps
  whole-text snapshots of `.md` and `.canvas` files in the profile's IndexedDB
  (`<appId>-file-recovery`), one when a file is opened and then at most one
  per `intervalMinutes` (default 5) after edits, pruned after `keepDays`
  (default 7); a restore snapshots the current text first. Snapshots, and
  one waiting for the interval, follow a renamed file; deleting a file with
  one waiting saves its last text at once. Templates insert a
  template's frontmatter at the top, adding only the properties the note
  lacks. On a case-insensitive volume the Daily notes and Templates folders
  are found as the disk spells them (`vault.getDiskPath`, justnotes' own), so
  a setting naming `daily` for `Daily` opens, creates and steps between the
  notes there. `properties` is the All properties pane
  (`all-properties`, `properties:open`): names with type and note count,
  unfolding to their notes; its menu sets the type or renames the property in
  every note (each note's YAML changed only at that key). Slides
  (`slides.ts`, off without core-plugins.json, as in Obsidian) presents the
  active note, or the note of a More options or tab menu, from its open
  view's text: slides are the text between top-level `---` rules
  (`slideSources`; not the frontmatter, a setext heading, or a rule in code,
  math, a list or a quote; empty slides dropped), each rendered with
  `MarkdownRenderer.render` into reveal.js's markup (`.slides-container` >
  `.reveal` > `.slides` > `section.slide`, `aside.controls` with
  `.navigate-left`/`-right`, `.slide-number`, `.progress`; the close button,
  `.slides-close-btn`, is a guess), since Obsidian's Slides is built on
  reveal.js. The 960x700 slide scales to the window as reveal.js scales it;
  content larger than its slide is shrunk with CSS `zoom` (a zoomed box
  reports its unzoomed size, so fitting never feeds back into the observer,
  and a slide that still overflows at half size scrolls only as far as its
  content; a transform would leave the unscaled box in the scroll range).
  It opens in the focused window, asks for fullscreen (refused without a user
  gesture, so CDP `eval` starts get the full window) and closes when
  fullscreen ends; its key scope has no parent, so app hotkeys stay off while
  it shows. Audio recorder (`audio-recorder.ts`, off without
  core-plugins.json, as in Obsidian) records the microphone with
  MediaRecorder from its ribbon button (`audio-recorder:Start/stop
  recording`, red while recording: `.is-recording`, a guess) or its two
  commands; turning it off ends a recording and saves it. A recording is
  WebM/Opus as Obsidian's desktop recordings (MP4, then Ogg, only where WebM
  is not recorded), named `Recording YYYYMMDDHHmmss.webm`, saved through
  `importFile` into the attachment folder for the active note and embedded
  at its cursor on a line of its own (Obsidian's docs say at the end of the
  note); with no note open it opens in a tab. Media players
  (`createMediaPlayer` in `markdown.ts`, used by embeds in both views and by
  the `audio`/`video` views of `media-view.ts`, registered at boot for
  Obsidian's extensions) turn a video file without a picture into an audio
  player and make Chromium find the missing duration of MediaRecorder's
  WebM by seeking past the end once, so recordings can be scrubbed. Main
  grants media only as `media.ts` decides: the microphone alone, to a vault
  page's main frame (iframes, `<webview>` guests and the camera are
  refused), after `systemPreferences.askForMediaAccess` on macOS when the
  system has not decided yet; with `--use-fake-device-for-media-stream` it
  skips the system check. Not there yet: the other core plugins,
  the Tags view's Mod-click to add a tag to the search, links to an
  extracted heading (`[[Note#Heading]]`) are not redirected to the new note.
- Bookmarks (`bookmarks-data.ts`: format, merge, rename/delete following,
  tested; `bookmarks.ts`: instance, view, dialog, commands, menus). The
  instance (`app.internalPlugins.plugins.bookmarks.instance`, created in
  `registerCorePluginViews`) has Obsidian's members plugins read: `items`
  (the array is kept; reloads splice into it), `getBookmarks()` (all but
  groups), `bookmarkLookup`/`urlBookmarkLookup`, `getItemTitle`,
  `addItem(item, group?, index?)`, `removeItem`, `moveItem`, `editItem`,
  `openBookmark(item, newLeaf)`, `onItemsChanged(save)`, `saveData()` and the
  `changed` event. Items are saved in `<configDir>/bookmarks.json`, the one
  Obsidian config file justnotes writes, because bookmarks are vault data the
  owner shares with Obsidian and syncs with git: written only after a
  bookmark changes (never on load, never created empty), with
  `JSON.stringify(data, null, 2)` and new items' keys in Obsidian's order
  (`type`, `ctime`, `path`, `subpath`, `query`, `url`, `options`, `items`,
  `title`), unknown fields and types kept in place. The file is re-read on
  its vault `raw` event; every sync reads the file first, and if it changed
  since the last read or write, `mergeBookmarks` three-way merges it (items
  are told apart by `type` and `ctime`; `ctime()` keeps new ones unique).
  Without changes of ours the file is taken as it is and not rewritten; a
  file that does not parse is left alone and nothing is saved until it does.
  Bookmarks follow renamed files and folders and go with deleted ones.
  Commands: `bookmarks:open`, `bookmark-current-view` (a file, the search
  view, the global graph; Edit bookmark when bookmarked),
  `bookmark-current-search`, `bookmark-current-heading`,
  `bookmark-current-section` (the block under the cursor, given a `^id` when
  it has none), `bookmark-all-tabs` (a new group) and
  `unbookmark-current-view`, and justnotes' own `bookmarks:bookmark-url`.
  Menus: file (Bookmark.../Edit bookmark...), files (several), editor (on a
  heading line), tab (`leaf-menu`, graph and search), and `url-menu`
  (Bookmark link.../Edit bookmark... on an external link). The view drags
  rows through `app.dragManager` (`type: "bookmarks"`, `items: [{item}]`,
  `files`), before/after a row or into a group, and takes files dragged from
  the explorer. URL bookmarks, which Obsidian makes from its Web viewer
  (justnotes has none), come from the Bookmark a URL dialog (the view's
  globe button, its background menu, a group's menu, the command; URL first,
  title following the URL's host and path until typed, a group), from the
  link menu, and from drops: an external link through the drag manager
  (`type: "link"` with a URL as `linktext`, its title kept), or a drop from
  outside (`text/uri-list`, else plain text whose every line is a URL with a
  scheme; a page link's anchor text is the title). `bookmarkUrl` checks every
  URL saved (dialog, drops, menu, CLI): a bare host gets `https://`, and a
  scheme main's external-link policy drops (`droppedSchemes` in
  `main/link-policy.ts`, shared with main) is refused. Edit... changes a URL
  bookmark's URL and title; opening it is `window.open`, so main's policy
  decides. `addItem` puts an item without a `ctime` (from the CLI or a
  plugin) in Obsidian's key order. Not there yet: the tab group's "Bookmark
  N tabs" menu, a heading bookmark does not follow a renamed heading.
- Graph view (`graph-data.ts` for options, queries and nodes, tested;
  `graph-renderer.ts` for the canvas; `graph-view.ts` for the views): a
  d3-force simulation drawn with Canvas 2D, frames only while the layout moves
  or a hover fades, several simulation steps a frame within a 6 ms budget.
  Nodes come from `resolvedLinks`/`unresolvedLinks` (unresolved nodes are
  keyed by link text, tags by `#tag`); the search filter and colour groups
  use one subset of Obsidian's search syntax (`compileQuery`), reading note
  texts only for content terms. The global graph's options start from
  `graph.json` (read only) and changes live in the view state (`options`),
  as the local graph's do; `scale` is the zoom. Colours come from the
  `.graph-view.color-*` probe classes and `--graph-*` variables, re-read on
  `css-change`. The local graph follows `file-open` and centres on its note.
  The slider-to-d3 mapping (`setForces`) was tuned by eye, not taken from
  Obsidian. A hidden page runs no `requestAnimationFrame`: frame-time checks
  over CDP need the test window shown (`showInactive()` on the remote
  window); the ~560-note courses text copy runs at the display rate.
- Canvas (`canvas-data.ts`: format, merge, geometry; `canvas-nodes.ts`;
  `canvas-view.ts`) registers its view, the `canvas` extension, `canvas:new-file`,
  the ribbon button and the folder menu's "New canvas" only when enabled.
  `view.canvas` keeps Obsidian's private names that plugins read: `nodes` and
  `edges` (Maps by id), `selection` (a Set), `getData`/`setData`,
  `requestSave`, `createTextNode({pos, size, text, focus})`, `selectOnly`,
  `deselectAll`, `zoomToFit`; a text node has `text` and `setText`, a file
  node `file` (the TFile). QuickAdd's capture into the active canvas uses
  exactly those (one selected text or file card); its capture to a configured
  card reads and rewrites the file with `JSON.stringify(data, null, "\t")`.
  Files are written in Obsidian's layout (one node or edge per line), only
  after a change, and keep unknown fields of nodes, edges and the file in
  place. Renaming a file or folder rewrites the canvases that show it, open
  or not. Link cards show the URL, not the page. Drops onto the canvas: files
  dragged from the explorer, search results or link panes become file cards
  at the pointer, several next to each other (`dropLayout`: a row of up to
  four, then a grid, centred on the drop point); a folder adds the files
  directly in it. Images and videos keep their aspect ratio inside the
  400x400 card (`fitSize`), audio gets a short card. A dragged link adds a
  card for its file and subpath, an unresolved one a text card holding the
  link. Files from the OS go through `importFile` (`attachments.ts`, shared
  with the editor's paste and drop) into the attachment folder for the
  canvas, a file already in the vault is used in place; a URL (`uri-list`, or
  plain text that is one URL) makes a link card, other text a text card. The
  card menu's buttons also drag onto the canvas. A multi-card drop is one undo
  step. Selecting a card brings it to the front of its layer (groups stay
  under the other cards) and last in the node list, which the next save
  writes; the click alone writes nothing. Not there yet: snapping, editing a
  note card in place (double-click opens it in a tab), PDF cards (shown as a
  file card), export.
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
- A plugin's enables and disables (`Plugins`, the toggles, the CLI) run one
  at a time in call order; a call from the plugin's own code while one runs
  (disabling itself in onload) runs at once, or it would wait for itself.
- `registerCodeMirror` is a no-op: it only ran in Obsidian's legacy editor.
- `app.metadataTypeManager` has Obsidian's private members: `properties`
  and `getAllProperties()` (lowercased name to `{name, type, widget, count,
  occurrences}`), `types` (assigned), `getPropertyInfo`, `getAssignedType`,
  `getTypeInfo(name, value?)` (`{expected, inferred}` widgets; QuickAdd calls
  it without a value and reads `.type`), `getWidget`, `setType`, `unsetType`,
  `registeredTypeWidgets` and the `changed` event. Assignments are Obsidian's
  defaults (`tags`, `aliases`, `cssclasses`), then `types.json` (re-read when
  it changes), then the `property-types` localStorage key. Widgets render with
  `render(el, value, ctx)`; Bases types its values through the same manager.
- A code-block language has one handler, the latest registration, in both
  views. Live Preview re-renders when processors change; the reading view keeps
  what it rendered until it re-renders.
- External links: renderer code opens a URL with `window.open(url, "_blank")`,
  never `shell.openExternal`. Main applies one policy to window opens,
  navigations and the openExternal permission requests of every session
  (`<webview>` partitions included): `obsidian:` goes to the vault window (a
  guest's to its embedder's); `file:`, `javascript:`, `data:`, `blob:`,
  `about:` and browser schemes are dropped; every other scheme goes to the
  system, as in Obsidian. An external link's menu (reading view and Live
  Preview: Open link, Copy URL) fires the workspace's `url-menu`
  (`addUrlMenuItems` in `markdown.ts`).
- `obsidian://open?path=` into another vault, and a URL whose `vault=` is
  another vault's folder name (`vaultNamed`: exactly one, never a path),
  opens (or focuses) that vault's window, which takes the URL, but only for
  vaults opened before with `--vault` or the folder
  picker (recorded in the profile's `vaults.json`): a link must never load an
  unknown folder's plugins. The built-in `open` and `new` refuse a `file=` or
  `name=` with a `..` or hidden (`.obsidian`, `.git`) segment
  (`urlPathOutsideNotes`): a link must never write plugin code or settings.
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
- Explorer items drag through `app.dragManager` (`drag-manager.ts`), Obsidian's
  private drag API: `draggable` holds `{ type: "file" | "folder" | "files",
  file | files, title, icon, source }` until the drag ends (`dragend`, or
  right after the dispatch of a drop, which a target may stop or which may
  re-render the dragged row; watched in every app window), and drop targets name
  their action with `setAction` on the ghost that follows the pointer.
  Search results, backlink and outgoing-link rows drag their file;
  `dragLink` (`type: "link"`, `linktext`, `sourcePath`) is what links in
  rendered Markdown, outline headings and unresolved outgoing links drag.
  `onDragStart` clears the element's own drag data (an anchor's URL), so
  targets read only `draggable` and CodeMirror inserts no text.
  Terminal 3.29 reads it to type the dragged paths; the editor accepts the drag
  in `dragover` on its whole DOM (the drag carries no data, so the browser would
  not drop it) and inserts links where it lands; the canvas adds cards.
- Never write Obsidian's own config files (`workspace.json`,
  `community-plugins.json`, `app.json`, `appearance.json`, `hotkeys.json`,
  `core-plugins.json`, `types.json`). The one exception is `bookmarks.json`
  (see Bookmarks above): bookmarks are content the owner keeps in both apps
  and in git, not app settings. justnotes state lives in localStorage through
  `app.saveLocalStorage` (keys prefixed with the vault id): `justnotes-layout`
  (the layout, in `workspace.json`'s shape, with leaf ids), `enabled-plugins`
  (the Settings toggles, applied over `community-plugins.json`),
  `enabled-core-plugins` (the Core plugins toggles, over `core-plugins.json`), `custom-css`
  (theme and snippets), `justnotes-expanded` (explorer folders),
  `property-types` (property type changes made in justnotes, layered over
  `types.json`; an empty type unassigns one). The language
  is localStorage `language`, else `en`; never the OS locale.

## Command line

- `justnotes [--profile <dir>] [--offline] [vault=<name|path>] <command>
  [key=value ...] [flag ...] [--json] [--copy]` has Obsidian's built-in CLI
  commands with their names, flags and syntax (docs.obsidian.md, "Obsidian
  CLI"; the source is `en/Extending Obsidian/Obsidian CLI.md` in
  obsidianmd/obsidian-help), justnotes' own, and the handlers plugins register
  with `registerCliHandler`. A built-in wins over a plugin handler of the same
  name. `justnotes help` lists them by group; `help <command>` shows flags.
- Syntax (`args.ts`): bare flags are `"true"`, `\n`, `\t` and `\\` unescape in
  values, `--key value` takes the next word for a flag declared with a value
  or an undeclared key, never for a declared switch. Undeclared keys pass
  through, because QuickAdd (the only owner's plugin with handlers) reads
  `value-<id>=...` and other keys as variables. `content=-` and `code=-` read
  stdin byte for byte (the command escapes backslashes before sending, never
  `status=-`, which is a task status). `--copy` (anywhere) also copies stdout
  with pbcopy, clip or wl-copy/xclip/xsel; `--json` (anywhere) prints any
  built-in's result as JSON.
- Output (`output.ts`): every built-in returns data plus text. Lists take
  `format=tsv|csv|json|md|yaml|paths` and `total`: tsv has no header (for
  `cut`), csv and md have one. A handler's string goes to stdout with status
  0, whatever it says (QuickAdd reports `"ok":false` in its JSON); a failure
  is status 1; an unknown command, an unknown `vault=`, a bad value or a
  missing flag is 2. Obsidian commands justnotes leaves out answer why, with
  status 2 (`missingReason`): Publish, Sync, `web`, `plugin:install`,
  `theme:install`, `dev:mobile`, and `workspace:save`/`delete` (they would
  write workspaces.json).
- Where a built-in runs (`spec.ts`): `vault` (marked `*` in help) and `app`
  commands run in the vault window; `main` ones (`vaults`, `vault:open`,
  `restart`, `quit`) in main; `completion` in the command. With no app
  running, a `vault` command reads the vault folder itself: `offline.ts`
  loads the app's own Vault, MetadataCache, MetadataTypeManager and
  InternalPlugins (core plugin options) in Bun, after
  `installLanguageExtensions()`, and writes nothing. When that cannot answer
  (no `file=` for an active-file default, a change such as `task toggle`) the
  handler throws `NeedsApp` and the command asks the app instead; every other
  command starts the app when none runs (from source `electron <repo>
  --vault <v> [--profile <dir>]`, needing `bun run build`; inside the
  packaged app its own binary, `appCommand`), detached, and waits for its
  socket, as Obsidian's first command launches Obsidian. `--offline` never
  asks or starts the app. A running app that has no window for the vault of
  a `vault` command (`read: true` in the request) answers `unopened` and the
  command reads the folder; for any other command main opens the vault's
  window (and records it in `vaults.json`) first.
- Which vault (`vaults.ts`, the same in main and the command): a leading
  `vault=` by folder name (open vaults, then the profile's `vaults.json`) or
  path; else the vault holding the working folder (open, known, or the nearest
  folder above with `.obsidian`); else the focused window's. `file=` resolves
  like a wikilink (base commands also try `<name>.base`), `path=` is exact;
  with neither a command acts on the active file.
- In the window `renderer/cli.ts` waits for `metadataCache.onCleanCache`
  before and after a built-in, so a command sees what the previous one wrote.
  Writes go through the app: `vault.process` (open editors merge them),
  `frontmatter-edit.ts` for properties (only the property's lines change; a
  `type=` is recorded through `metadataTypeManager.setType`, never
  types.json), `fileManager.renameFile` for `move`/`rename` (links follow
  `alwaysUpdateLinks`), trash per `trashOption` for `delete` and the
  uninstall commands. Core plugins cannot be toggled (core-plugins.json is
  Obsidian's); `bookmark` goes through the Bookmarks instance's `addItem`
  when that core plugin exists (`url=` checked as the dialog checks it, a
  bad URL is status 2); history commands read File recovery's
  snapshots (`fileRecoveryOf`), only while it is enabled; `workspace:load`
  applies a layout from workspaces.json. `dev:console` and `dev:errors` read
  buffers `dev-capture.ts` fills from boot (console methods wrapped, window
  `error` and `unhandledrejection`).
- justnotes' own additions: `--json` everywhere, read-only commands without
  a running app, starting the app on demand, `vault:open` (opens a vault
  window, starting the app; Obsidian's is TUI-only), `quit`, `neighbours`
  (the local graph's nodes to a depth, by direction), `command name=` (a
  palette name, exact or the one containing it), `commands verbose`, stdin
  content and `completion zsh|fish|bash`.
- Completion (`completion.ts`, `complete.ts`): the scripts hold no command
  list; on every Tab they run the hidden `justnotes __complete <words before
  the cursor> <current word>`, which prints `word<TAB>description` lines
  (never an error, status 0) and the shell filters them; a word ending in `=`
  or `/` takes no space, and the shell completes `--profile`'s folder itself.
  Candidates: built-ins and their flags from `spec.ts` (an enumerated value
  `a|b` as `key=a`, `key=b`; flags already on the line are left out), the
  vault's plugin commands and their CliFlags, `vault=` with the profile's
  known vaults (a path where two share a name), `path=` one folder level of
  the vault at a time and `file=` note names (`.md` dropped) from a walk
  capped at 20,000 entries, hidden folders skipped. Plugin commands come from
  the running app: a `complete` request (150 ms timeout) that main answers
  from what the vault's window last reported, picking the vault as for a
  command but opening no window, waiting for none and running nothing; it
  answers `{vault, commands}`, `commands` null when no ready window shows
  the vault. Otherwise, and with `--offline`, they come from
  `<profile>/cli/completion.json` (0600, folder 0700) for the vault picked
  locally (vault= or the working folder; no focused window, so none outside
  a vault). The window reports `pluginCommands()` after `installCli` and
  after every `app.cliHandlers` change (`CliHandlers.onChange`, debounced
  200 ms), and main rewrites that vault's entry; a closed vault keeps its
  last entry, and anything malformed in the file is dropped on read.
  `__complete` never starts the app; it takes about 20 ms.
- The socket: main serves one per profile at
  `<profile>/cli/justnotes-cli.sock` (folder 0700, socket 0600; a named pipe
  keyed by the profile on Windows), never a network port. A socket path past
  sockaddr_un's limit (a deep `--profile`) is bound and connected relative to
  its folder after a `chdir`, which main undoes at once (Node binds
  synchronously). A window takes requests after `installCli` (end of boot)
  says it is ready; earlier requests wait up to a minute, and a reload, crash
  or close answers pending ones with an error. A socket file left by a killed
  instance is replaced on the next start; a live one (another instance on the
  same profile) is left alone and that instance serves no CLI.
- On PATH (not done by the repo): from source the bin is
  `src/cli/justnotes.ts`, an executable Bun script that finds the repo
  through its real path, so a symlink works: `ln -s
  <repo>/src/cli/justnotes.ts ~/.local/bin/justnotes` (with `~/.local/bin`
  and `bun` on PATH), or `bun link` in the repo. The packaged app's command
  needs neither Bun nor the repo: `ln -s
  /Applications/justnotes.app/Contents/Resources/cli/justnotes
  ~/.local/bin/justnotes` (Packaging and releases). Shell
  completion: `justnotes completion zsh > ~/.zfunc/_justnotes` (with
  `~/.zfunc` in `fpath` before `compinit`; `source <(justnotes completion
  zsh)` also works), `justnotes completion fish >
  ~/.config/fish/completions/justnotes.fish`, `source <(justnotes completion
  bash)` (bash 3.2 and later). The scripts call `justnotes` on PATH, so they
  need no regenerating when commands change.

## Packaging and releases

- electron-builder (`electron-builder.yml`, pinned in devDependencies)
  packages the built `dist/`: `bun run dist:mac` makes `justnotes.app` for
  arm64 and x64 as `.dmg` and `.zip`, `bun run dist:win` an x64 NSIS
  installer (`-setup.exe`, per user, folder choosable) and `.zip`, `bun run
  dist` both; each runs `bun run build` first. Output goes to `release/`
  (ignored). Name, version and author come from package.json, the app id is
  `io.github.qiulinfan.justnotes`. The default profile is the same
  `justnotes` user data folder the source build uses.
- The asar holds `package.json`, `dist/` without source maps and the
  command, and of node_modules only `@electron/remote`, which main and the
  page require at runtime; every other dependency is bundled by esbuild or
  copied into `dist/lib` (MathJax, pdf.js, Mermaid, Prism). A new runtime
  `require` of a package needs an entry in `files`. There are no native
  modules (`npmRebuild: false`). Nothing reads the repo at runtime:
  `__dirname` is `app.asar/dist`, and `file:///lib/` maps into it.
- The command: `build.ts` bundles `src/cli/justnotes.ts` to
  `dist/cli/justnotes.mjs` (ESM for its top-level await, with a `require`
  for bundled CommonJS; the version is package.json's, imported at build
  time), which goes outside the asar to `Contents/Resources/cli` (macOS) or
  `resources\cli` (Windows) with its launcher, `packaging/justnotes` (sh,
  follows symlinks) or `packaging/justnotes.cmd`. The launcher runs it with
  the app's own binary as Node (`ELECTRON_RUN_AS_NODE=1`), so the Electron
  fuse RunAsNode must stay on. Under Electron (`process.versions.electron`)
  `appCommand` starts `process.execPath` without that variable; from source
  it starts the checkout's electron.
- Markdown files: the macOS app declares `.md` and `.markdown` as an
  Alternate Editor (offered in Open With, never taking the default app);
  Windows declares no association, because NSIS would make justnotes the
  default `.md` handler. A file arrives as `open-file` (macOS, at launch
  before `ready`) or as an argument (any platform); `openFile` in `main.ts`
  opens it in the vault holding it (a known vault, else the nearest folder
  above with `.obsidian`, else its folder) through `obsidian://open?path=`,
  asking first for a vault not opened before, since its plugins would run.
  The app still does not register `obsidian://` with the OS (see Layout), so
  only links inside the app, `obsidian://` launch arguments and the command
  reach it.
- No signing certificates: the macOS app is ad-hoc signed (`identity: "-"`;
  Apple silicon refuses unsigned code) and not notarized, the Windows
  executables are unsigned. A downloaded copy is quarantined: right-click >
  Open on first launch (macOS 15 and later: System Settings > Privacy &
  Security > Open Anyway), or `xattr -dr com.apple.quarantine
  /Applications/justnotes.app`. Windows SmartScreen asks once (More info >
  Run anyway).
- Cross-building Windows on a Mac works except the NSIS step on Apple
  silicon without Rosetta: the default makensis is x86_64. Locally use the
  arm64-capable toolset, `bun run dist:win -c.toolsets.nsis=1.2.1` (a beta
  bundle, makensis 3.12); CI builds on Windows with the default.
- Verify a package by launching its binary directly, never an installed
  copy: `release/mac-arm64/justnotes.app/Contents/MacOS/justnotes
  --use-mock-keychain --vault <copy> --profile <dir>
  --remote-debugging-port=<port>` (drive it with `CDP_PORT=<port> bun
  scripts/cdp.ts`), and its command
  `release/mac-arm64/justnotes.app/Contents/Resources/cli/justnotes
  --profile <dir> ...` (`version`, an offline read, an app command; with no
  app running it starts the packaged one). `open -a <app> <note.md>`
  exercises `open-file` but launches without `--profile` unless given
  `--args --profile <dir>`; without one it uses the real default profile.
- CI (`.github/workflows/build.yml`, actions pinned by commit): on pushes
  and pull requests to main, macOS (macos-15) runs `bun install
  --frozen-lockfile`, `bun run check`, `bun test test`, `bun run build` and
  packages; Windows (windows-2025) checks, builds and packages without the
  tests, which assume POSIX (Unix sockets and file modes, symlinks, bash
  completion). Bun's cache and the Electron and electron-builder downloads
  are cached; the packages are workflow artifacts (`justnotes-macOS`,
  `justnotes-Windows`).
- Release: bump `version` in package.json, commit, tag `v<version>` and push
  the tag. The workflow checks the tag matches package.json and creates a
  draft GitHub Release with the `.dmg`, `.zip` and `-setup.exe` files and
  generated notes; publish it by hand.

## Views, files and saving

- TextFileView saves through `vault.process`, so reading, merging and writing
  are one step and a plugin's concurrent write is merged, not lost. An outside
  change to an open file merges line by line with unsaved edits (`mergeText`,
  a line diff3), including lines one side added next to a line the other side
  changed; a real conflict keeps both versions and shows a notice. The take-in
  during a save, the reload on vault `modify` and the quit flush all merge
  this way. A view whose text is structured data registers its own merge with
  `mergeWith` (the canvas merges by node and edge id, field by field, so a
  merge never yields broken JSON; a field changed on both sides takes the
  file's value).
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
  real view when a plugin registers the type.
- Popout windows follow Obsidian's model (`popout-window.ts`, `WorkspaceWindow`
  in `workspace.floatingSplit`): a child window of the vault page opened with
  `window.open("about:blank")`, in the same renderer, whose document the
  page's code builds and drives. Main gives it `nodeIntegration: false`;
  with Node on, Electron puts the child in its own browsing instance and
  `window.open` returns null. Its body repeats the vault window's container
  chain plus `is-popout-window`; the vault window's stylesheets (in order,
  CSSOM-added rules included), `<html>`/`<body>` classes and inline styles are
  mirrored into it. Leaves moved there keep their DOM (an iframe in it
  reloads). `getLeaf("window")`, `openPopoutLeaf`, `moveLeafToPopout`, the
  tab menu, `workspace:open-in-new-window`/`move-to-new-window` and
  Mod+Alt+Shift links open one; `window-open`/`window-close` fire with the
  `WorkspaceWindow` and its `Window`. A popout whose last tab goes closes;
  closing the window closes its leaves. The layout stores windows under
  `floating` (`type: "window"`, `x`, `y`, `width`, `height`) and reopens them;
  on unload the page saves the layout first, then closes popouts without
  saving again. While the app quits, main keeps popouts open until their
  page goes (Electron closes them first otherwise), so the quit flush saves
  them in the layout. New tabs, splits and `getLeaf(false)` follow the active leaf
  into its popout.
- Cross-window rules: a node keeps the realm it was made in when it moves
  (`constructorWin`), so DOM `instanceof` checks in host code use
  `.instanceOf()`; `el.createEl` makes elements in the parent's document and
  every popout realm gets the DOM augmentations (`addWindow`). A ResizeObserver
  sees only its own window's elements, so host code uses `AppResizeObserver`.
  Listeners on a window (keymap, `lastEvent`, focus tracking, tooltips) are
  installed in every popout through `onWindowAdded`. Modals and notices open
  in `activeDocument` (the focused window, also set by `setActiveLeaf`),
  menus in the event's document, suggests and popovers in their anchor's.
  MarkdownView's CodeMirror calls `setRoot` on `onWindowMigrated`.
- Tabs drag with HTML5 drag and drop, across windows too: onto a tab bar
  (a bar marks the position), onto a pane's middle (into its group) or the
  outer quarter of an edge (`dropZone`: a new group split off on that side;
  sidebar panes only above or below). `.workspace-drop-overlay` shows the
  target; `body.is-grabbing` keeps `<webview>`/`<iframe>` guests from taking
  the drag. A main-area tab dropped outside every app window moves to a new
  popout there. Moves go through `removeChild`/`insertChild`, so
  `layout-change` fires and the layout saves the result.
- Resize drags end on `lostpointercapture`, and `body.is-resizing` turns off
  pointer events in `<webview>` and `<iframe>` guests, which would otherwise
  swallow the moves and the pointerup (omp-sidebar's webview).
- Before the window closes, main asks the renderer to save open views, the
  layout and plugins' quit tasks, and waits for the reply.
- Properties edits (Live Preview and reading view alike) are transactions on
  the note's CodeMirror document (`editorMetadataHost`), so they save, merge,
  undo and reach other panes like typing. `frontmatter-edit.ts` rewrites only
  the changed property's lines: the others keep their bytes (order, quotes,
  comments), and the changed one keeps its flow or block list style, item
  indentation, quotes and a trailing comment. A flow-style map is rewritten
  whole. Removing the last property removes the block. YAML that does not
  parse to a map shows "Invalid properties", which opens the YAML.
  `fileManager.processFrontMatter` (QuickAdd, Bases cells) applies what its
  callback changed the same way, property by property, and throws on YAML
  that is not a map rather than replacing it.

## Live Preview and math

- Decorations are one `StateField` rebuilt from the syntax tree on doc,
  selection or tree changes. Block math needs a state field (view plugins
  cannot replace line breaks). Typing on a 5500-line note stays within a frame.
- Reveal rule: inline syntax shows while any selection touches the element;
  line syntax (heading marks, quote marks, list bullets, tasks, rules, block
  math) shows while the selection is on those lines.
- `editorLivePreviewField` false means Source mode: no decorations at all.
- Raw HTML: an `<img>` alone or inline becomes an `HtmlImageWidget` (its src
  found as the reading view finds it); any other HTML block (`<p
  align="center">`, `<div>`, `<details>`, ...) renders through
  `MarkdownRenderer`, sanitized like the reading view, as a block widget
  (`.cm-html-embed`) until the selection enters its lines.
- The frontmatter is a block widget holding a `MetadataEditor` (also in the
  reading view's `mod-header`), unless "Properties in document"
  (`propertiesInDocument`) is `source` (YAML) or `hidden`; Live Preview
  rebuilds on `config-changed`. The widget's `updateDOM` syncs rows in place,
  so a field being edited keeps its focus; rows move only when out of place.
  Its text fields are `<input>`/`<textarea>`, never contenteditable: inside
  `.cm-content` a nested editing host lets select-all and the selection
  escape into the note. Keys typed in the block never run editor commands
  (`keyInOtherField`). Keyboard as in Obsidian: on a row, Up/Down or Tab move,
  Shift+Up/Down extend the selection, Left edits the name, Right or Enter the
  value, Escape returns to the row, Mod+Backspace deletes, Mod+Z undoes,
  Alt+Down goes to the note; ArrowUp from the note's first line enters the
  block. `markdown:add-metadata-property` (Mod+;) adds a row, writing an empty
  block first when the note has none; a property reaches the YAML once named.
  A type change converts the current note's value only when the conversion is
  faithful; otherwise the value stays and its row shows a type mismatch.
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
- Sidebar sizes come from Obsidian's component variables, never fixed
  numbers: tree rows (`.tree-item-self`, explorer, bookmarks, tags, outline,
  search and link panes) take `--nav-item-size`, `--nav-item-padding`,
  `--nav-item-margin-bottom` and `--line-height-tight`, children
  `--nav-item-children-*` and the indentation guide, tabs `--tab-*`, the
  ribbon `--ribbon-*`, the status bar `--status-bar-*`, icons `--icon-size`
  and `--icon-stroke` set on their container. docs.obsidian.md names the
  component variables without values; `00-base.css` holds the default
  theme's, as themes restate them. A row's collapse chevron sits in its left
  padding, over the children's indentation guide, so file and folder names
  line up.
- Links take their colours from the `--link-*` variables, and a base `a` rule
  gives plain anchors in plugin views the link colour. Live Preview's link
  marks carry `.internal-link` and `.external-link`, so the reading view's link
  rules style them too.
- Host overlays sit on the same `--layer-*` scale as Obsidian's (status bar,
  popover, modal, notice, menu and suggestion, tooltip). Each `.cm-editor`
  isolates its stacking, so CodeMirror's own panel (300) and tooltip (500)
  z-indexes stay under host overlays. A leaf showing a CodeMirror tooltip goes
  above the other leaves (`z-index: 1`), so a tooltip that reaches past its
  pane (tinymist's completion docs and formula hovers beside its preview pane)
  is not covered by the panes after it.
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
(0.1.5 and 3.0.2), latex-live (0.1.0, 0.1.7 and 0.2.0), obsidian-git (2.41.1
and 2.42.0), omp-sidebar, quickadd (2.24.2 and 2.33.1), terminal (3.27.2 and
3.29.0) and obsidian-tinymist (0.1.0, its YOLO bridge against a local mock
provider). QuickAdd's capture into the active canvas and into a configured
card were tested on a synthetic vault. In a popout window Markdown editing,
Completr's and the link suggests, latex-live's math, QuickAdd's modals and
menus and a terminal moved there (its `onWindowMigrated` reopens xterm) were
tested live. All thirteen, translate (0.1.0) included, also loaded with no
errors in the real notes vault, where translate's hold-Shift popup returned a
DeepSeek translation (one paid call of a fraction of a cent; it reads its key
from a file under `~/Desktop/apis`), and the core plugin panes, a popout and
the CLI worked; the vault's git state was unchanged afterwards. Loading
rewrites `plugins/terminal/data.json` and obsidian-git's
`obsidian_askpass.sh`, as in Obsidian. Bookmarks (every item type, groups, drags, renames and
deletions, a bookmarks.json changed outside while justnotes saved; URL
bookmarks from the dialog, the link menus, outside and in-app drops and the
CLI) and the
Core plugins toggles were tested live on a synthetic vault and on a copy of
blogs with five of its plugins.

## Verify

- `bun run check` (TypeScript), `bun run build`, `bun run test`; after a
  change to packaging, main's startup or the command, `bun run dist:mac`
  and the package checks in Packaging and releases.
- Test against a copy of a vault, never the owner's real vaults:
  `bun scripts/test-vault.ts <vault> <dest> [plugin-id ...]`. Plugins write
  their `data.json`, and some run external programs. The copy holds no link
  that points outside it: a plugin folder can be a symlink to the plugin's
  development checkout, whose `data.json` is the real one, and the script
  copies such a folder as files.
- `bun scripts/smoke.ts --vault <copy> --port <port> --profile <dir> [--keep]
  [-- <electron flag> ...]` launches an isolated instance (own profile, mock keychain, no background
  throttling) and reports boot errors; drive a kept one with
  `CDP_PORT=<port> bun scripts/cdp.ts` (real key events, `eval` against
  `window.app`, screenshots, `reload`; always set `CDP_PORT`, or it drives
  whatever listens on 9333; it attaches to the first vault page, and
  `CDP_POPOUT=<n>` to the n-th popout window for keys and screenshots; `eval`
  in the vault page reaches popouts' documents). A real tab drag needs
  `Input.setInterceptDrags` and `Input.dispatchDragEvent` on the target page;
  a page whose popout closes on the drop stops answering. Mouse input goes through `Input.dispatchMouseEvent`. Injected keys
  never trigger macOS menu key equivalents, so Cmd+A needs `cdp.ts selectall`;
  native `<select>` popups cannot be driven. A plugin's `<iframe>` from
  another origin (tinymist's preview on 127.0.0.1) is a target of its own
  (type `iframe` in `/json`): read positions inside it through that target,
  then click at them in page coordinates.
- Stub openers before clicking anything that may open a URL. Assigning
  `require("@electron/remote").shell.openExternal` patches only the renderer
  proxy; evaluate in main instead (`remote.require("vm").runInThisContext`
  with `process.mainModule.require("electron")`). Stubs in main survive
  `cdp.ts reload`; the page's do not.
- Never record the real microphone or raise macOS's microphone prompt: pass
  `-- --use-fake-device-for-media-stream` to `smoke.ts` (flags after `--` go
  to Electron), which gives getUserMedia Chromium's synthetic input and makes
  main skip the system check. Not `--use-fake-ui-for-media-stream`: it
  grants every media request before main's permission handler sees it.
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
  `GIT_CONFIG_NOSYSTEM=1`; obsidian-git 2.42.0 answers Git's credential
  prompts through its own askpass script and a loopback HTTP server, so test
  them with a local Git server that asks for Basic auth (`git http-backend`
  behind a small Bun server); quickadd keeps online features off; terminal shells
  are the owner's login shell, so launch with `fish_private_mode=1` and type
  nothing that should not run; latex-live keeps shell escape off and builds in
  the system temp folder, but copies hold no `.tex`: copy a project's whole TeX
  tree in (notes' projects `\input` sibling projects and `../toolchain`), and
  stub `dialog.showSaveDialog` in main before Export to HTML, which opens a
  native save dialog CDP cannot see; obsidian-tinymist runs two `tinymist lsp` processes
  (the editor's and the formula renderer) and a preview server on 127.0.0.1,
  rooted at the copy, but downloads a `@preview` package missing from Typst's
  package cache into that cache, so use fixtures whose packages are cached
  (`~/Library/Caches/typst/packages`). Copies get the vault's `.typ` and `.bib`
  files; notes has none, so copy in Typst fixtures (courses' `_editor-test`
  holds a demo and a book with a `.tinymist-preview.typ`). Its YOLO bridge
  completes through yolo: with yolo enabled, blank the copy's API keys and
  point its completion model at a local OpenAI-compatible mock (YOLO's chat
  protocol accepts `http://127.0.0.1`; Mercury FIM only Inception's host).
