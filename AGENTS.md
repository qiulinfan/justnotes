# justnotes development

justnotes is an Electron Markdown editor that hosts Obsidian community plugins.
It reimplements the `obsidian` module from scratch; never copy or unpack code
from Obsidian's `app.asar`. The references are the public typings
(`node_modules/obsidian/obsidian.d.ts`) and docs.obsidian.md.

The owner's goal: a local note tool with Live Preview, local search, and (not
built yet) one-way upload of the vault to a cloud drive for restoring on a new
device. No accounts, no sync service, no database: the files are the data and
everything else is derived in memory at startup. The only thing kept between
runs is a disposable cache of that derivation in the profile (see Caches),
never in the vault; deleting it changes nothing but the next start's time.

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
  One instance runs per profile (`app.requestSingleInstanceLock()`, which
  Electron keeps in the user data folder, so test instances with their own
  `--profile` stay independent): a second launch on a running profile hands
  its arguments and working folder to the running instance (`second-instance`;
  `--vault` folders, Markdown files and `obsidian://` URLs open there, read by
  `launchRequest` in `launch-args.ts` as the first launch's are; with none
  the vault window comes to the front) and quits. While the app quits a
  second launch's arguments are dropped.
  The only `window.open` it lets through as a window
  is a popout's (`popout.ts`: `about:blank` under the `justnotes-popout`
  frame name). `lifecycle.ts` runs the quit flush
  (`justnotes:before-close` / `justnotes:close-ready`), `ipc.ts` the
  synchronous IPC behind SecretStorage (Electron `safeStorage`) and the
  plugins' clipboard, `protocol.ts` scheme registration, `media.ts` which
  media requests are granted, `vault-switcher.ts` the vault switcher's IPC
  (see Vault switcher), `vault-picker.ts` the vault picker's window (its page
  is `src/picker/`), `pty.ts` the Terminal core plugin's pseudoterminals
  (see Terminal).
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
    `selection-scroll.ts` (drag-select scrolling), `image-menu.ts` (the
    image double-click menu), `editor-settings.ts`
    (justnotes' own editor options), `editor-options.ts` (the Editor
    settings that shape CodeMirror), `attachments.ts` (pasted and dropped
    files), `vault.ts`, `vault-config.ts` (app.json and appearance.json),
    `file-visibility.ts` (unsupported and excluded files), `metadata*.ts` (the cache; `metadata-store.ts`, its copy
    in the profile; `metadata-types.ts`, the
    `metadataTypeManager`; `metadata-editor.ts` and `metadata-widgets.ts`,
    the Properties block), `frontmatter-edit.ts`, `file-manager.ts`, `keymap.ts`,
    `internal-plugins.ts`, `secret-storage.ts`, `sanitize.ts` (DOMPurify),
    `setting-modal.ts` and `setting-options.ts` (the settings window and its
    Options pages), `ui/` (menus, modals, notices, settings, suggests,
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
  icon (`icon.svg`, rendered with `rsvg-convert -w 1024 -h 1024 packaging/icon.svg
  -o packaging/icon.png`; run from the repo, main sets it as the Dock icon) and
  the command's launchers.
  `electron-builder.yml` is the packaging configuration.
- `src/renderer/`: host UI (`loader.ts` runs the bundle, `boot.ts` starts the
  app; core commands, file explorer, search, view
  and workspace commands, bases view, the core plugins in `core-plugins.ts`
  and the modules it installs, `plain-text-view.ts`, `terminal/` for the
  Terminal core plugin) and `styles/NN-*.css`,
  which keep Obsidian's CSS variable and class names so plugin stylesheets
  apply (`93-latex.css` is latex-live's `styles.css`).
- `src/latex/`: obsidian-latex-live built in, the `latex` core plugin (see
  TeX and text notes below); its tests and fixtures are `test/latex/`.

## Compatibility rules

- Signatures come from `obsidian.d.ts`. Plugins also use private API; read the
  plugin's bundled `main.js` to see exactly what it touches and match that
  behavior instead of guessing. A quick inventory:
  `grep -oE "require\(['\"][^'\"]+['\"]\)"` for modules and
  `grep -oE 'app\.[a-zA-Z]+(\.[a-zA-Z]+)?'` for app members.
- Startup screen: main reads the vault's `appearance.json` theme (else the
  system's) to give the window its background and the page a `?theme=`, so
  `index.html` starts dark or light; its `.app-loading` overlay (the icon and an
  indeterminate bar, styles in `05-loading.css`) covers the page until boot
  restores the layout or fails, then fades out (`hideLoading`, on a timer
  because hidden windows run no animation frames).
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
  searches `tag:#x` on click; Mod-click adds the tag to a search of tags
  (`queryWithTag`; the search view and the CLI's search read `tag:` terms
  joined by spaces as AND, `tagTerms`) and replaces any other search. Note composer reads note-composer.json
  (`askBeforeMerging`, `replacementText` link/embed/none, `template` with
  `{{content}}`, `{{fromTitle}}`, `{{newTitle}}`, `{{date:...}}`): Enter adds
  at the end, Shift+Enter at the start (after the frontmatter), Mod+Enter (or
  Enter with no match) creates a note named as typed; a merged note's
  frontmatter adds only missing properties, links to it are redirected
  (`FileManager.redirectLinks`) and it goes to the trash. Text added to a
  CRLF note gets CRLF line breaks. Extracting a heading redirects the links
  into the section (`movedSubpaths`, judged in the text before): to a note
  made from it `[[Note#Heading]]` becomes `[[New]]` and a heading under it
  `[[New#Sub]]`; into another note, where the heading stays, subpaths are
  kept; block references keep theirs. File recovery keeps
  whole-text snapshots of notes (Markdown, TeX and text within the index
  limit) and `.canvas` files in the profile's IndexedDB
  (`<appId>-file-recovery`), one when a file is opened and then at most one
  per `intervalMinutes` (default 5) after edits, pruned after `keepDays`
  (default 7); a restore snapshots the current text first. Snapshots, and
  one waiting for the interval, follow a renamed file; deleting a file with
  one waiting saves its last text at once. Templates insert a
  template's frontmatter at the top, adding only the properties the note
  lacks. Properties are never added (by Templates or Note composer) to
  frontmatter that is not a map of properties, or that the added lines would
  not leave one (a flow map): `templateEdits` throws
  `FrontmatterNotMapError`, nothing is written and a Notice (the CLI an
  error) says why, as `processFrontMatter` refuses. On a case-insensitive
  volume the Daily notes and Templates folders are found as the disk spells
  them (`vault.getDiskPath`, justnotes' own), so a setting naming `daily` for
  `Daily` opens, creates and steps between the notes there. `properties` is the All properties pane
  (`all-properties`, `properties:open`): names with type and note count,
  unfolding to their notes; its menu sets the type or renames the property in
  every note (each note's YAML changed only at that key). Slides
  (`slides.ts`, off without core-plugins.json, as in Obsidian) presents the
  active note, or the note of a More options or tab menu, from its open
  view's text: slides are the text between top-level `---` rules
  (`slideSources`; not the frontmatter, a setext heading, or a rule in code,
  math, a list or a quote; empty slides dropped), starting at the slide
  holding the cursor when started from the note's editor (`slideIndexAt`; a
  rule line belongs to the next slide), each rendered with
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
  at the end of the note on a line of its own, as Obsidian's docs say (the
  cursor stays); with no note open it opens in a tab. Media players
  (`createMediaPlayer` in `markdown.ts`, used by embeds in both views and by
  the `audio`/`video` views of `media-view.ts`, registered at boot for
  Obsidian's extensions) turn a video file without a picture into an audio
  player and make Chromium find the missing duration of MediaRecorder's
  WebM by seeking past the end once, so recordings can be scrubbed. Main
  grants media only as `media.ts` decides: the microphone alone, to a vault
  page's main frame (iframes, `<webview>` guests and the camera are
  refused), after `systemPreferences.askForMediaAccess` on macOS when the
  system has not decided yet; with `--use-fake-device-for-media-stream` it
  skips the system check. Terminal (`terminal`, see Terminal) is justnotes'
  own, not Obsidian's: `JUSTNOTES_OWN` core plugins start on unless turned
  off on the Core plugins page, and may add a settings tab under "Core
  plugins" in Settings (`host.addSettingTab`). A core plugin can stand in for
  a community plugin (`REPLACED_BY` in `plugins.ts`): while it is on, that
  plugin is not loaded (its enabled choice stays; the Community plugins page
  says why and `smoke.ts` lists it under `replacedPlugins`), and turning the
  core plugin off loads it again. Not there yet: the other core plugins.
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
  Menus: tab group (the tab list's "Bookmark N tabs...", on the workspace's
  `tab-group-menu`, which the chevron at the end of a tab bar fires),
  file (Bookmark.../Edit bookmark...), files (several), editor (on a
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
  plugin) in Obsidian's key order. A heading bookmark does not follow a
  heading edited in place, as links to it do not in Obsidian; Obsidian's
  "Rename this heading..." command, which updates links, is not there yet.
- Graph view (`graph-data.ts` for options, queries and nodes, tested;
  `graph-renderer.ts` for the canvas; `graph-view.ts` for the views): a
  d3-force simulation drawn with Canvas 2D, frames only while the layout moves
  or a hover fades, several simulation steps a frame within a 6 ms budget.
  Nodes come from `resolvedLinks`/`unresolvedLinks` (unresolved nodes are
  keyed by link text, tags by `#tag`); the search filter and colour groups
  use one subset of Obsidian's search syntax (`compileQuery`), reading note
  texts only for content terms; a group also colours a tag node (a subject
  carrying that tag) or an unresolved node (one at the link text) its query
  matches (`nodeSubject`). Mod-hover on a note or image node shows page
  preview at the pointer (hover-link source `graph`, `targetEl: null`). The global graph's options start from
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
  node `file` (the TFile). The leaf's state keeps the viewport as Obsidian's
  workspace.json does (`viewState: {x, y, zoom}`, the canvas point at the
  middle and the zoom level), so the layout and history restore pan and
  zoom; a canvas opened without one is fitted. QuickAdd's capture into the active canvas uses
  exactly those (one selected text or file card); its capture to a configured
  card reads and rewrites the file with `JSON.stringify(data, null, "\t")`.
  Files are written in Obsidian's layout (one node or edge per line), only
  after a change, and keep unknown fields of nodes, edges and the file in
  place. Renaming a file or folder rewrites the canvases that show it, open
  or not; a rename through `fileManager.renameFile` also rewrites the links
  in text cards that no longer reach their file, as in notes (the plugin
  adds `canvasLinkHolder` to `fileManager.linkHolders`, justnotes' own hook
  for Markdown the metadata cache does not index). Link cards show the URL, not the page. Drops onto the canvas: files
  dragged from the explorer, search results or link panes become file cards
  at the pointer, several next to each other (`dropLayout`: a row of up to
  four, then a grid, centred on the drop point); a folder adds the files
  directly in it. Images and videos keep their aspect ratio inside the
  400x400 card (`fitSize`), audio gets a short card. A PDF card shows its
  pages as a PDF embed does (`renderPdfViewer`), scrolling inside the card. A dragged link adds a
  card for its file and subpath, an unresolved one a text card holding the
  link. Files from the OS go through `importFile` (`attachments.ts`, shared
  with the editor's paste and drop) into the attachment folder for the
  canvas, a file already in the vault is used in place; a URL (`uri-list`, or
  plain text that is one URL) makes a link card, other text a text card. The
  card menu's buttons also drag onto the canvas. A multi-card drop is one undo
  step. Selecting a card brings it to the front of its layer (groups stay
  under the other cards) and last in the node list, which the next save
  writes; the click alone writes nothing. The element moves to the front
  only once the click is over (or the drag starts): moving it under the
  pointer cancels the click, and with it a double-click or a link's. A
  double-click (or Enter, or Edit in its menu) on a whole-note card edits the
  note in place in Live Preview (a heading or block card opens the note):
  typing writes the note through `vault.process`, debounced, merged line by
  line with what the file got meanwhile, and a change from elsewhere merges
  into the editor; leaving the card ends the edit. A note card's links
  resolve from the note. A link clicked in a card (rendered, on release of
  the press; in a card's editor, on mousedown) opens as from Obsidian's
  canvas, never in the canvas's leaf: in the most recently active leaf of
  another tab group in the same root, else a new tab; Mod and a middle click
  pick the place as elsewhere (`Canvas.openLink`, through
  `workspace.openLinkTextIn`). Moving and resizing snap as canvas.json's
  `snapToGrid` and `snapToObjects` say (both on when unset, as in
  Obsidian; `snapMove`, `snapEdge`): a moved selection's left, centre or
  right (top, middle, bottom) onto another card's within 8 screen pixels,
  else its corner onto the 20-unit grid; a resized card's dragged edges
  likewise. Not there yet: export.
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
- The editor's context menu has Obsidian's Format, Paragraph and Insert
  submenus (`MarkdownView.showContextMenu`, editing view only); each item runs
  the `editor:` command of the same action, so hotkeys and plugins see one
  path. Insert footnote numbers after the note's highest `[^n]` and puts the
  definition at the end; Insert horizontal rule leaves a blank line after a
  paragraph, which `---` right under it would turn into a heading.
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
  vaults opened before with `--vault`, the vault picker or the vault
  switcher (recorded in the profile's `vaults.json`): a link must never load an
  unknown folder's plugins. The built-in `open` and `new` refuse a `file=` or
  `name=` with a `..` or hidden (`.obsidian`, `.git`) segment
  (`urlPathOutsideNotes`): a link must never write plugin code or settings.
- Vault switcher (`renderer/vault-switcher.ts`, main's side in
  `main/vault-switcher.ts`): Obsidian's vault profile at the bottom of the
  left sidebar, `.workspace-sidedock-vault-profile` holding
  `.workspace-drawer-vault-switcher` (`.workspace-drawer-vault-switcher-icon`,
  a chevrons-up-down, then `.workspace-drawer-vault-name`) and
  `.workspace-drawer-vault-actions` (Help first, Settings last, as themes
  hide them by `:first-child`/`:last-child`). The sidedock keeps it after its
  panes (`WorkspaceSidedock.footerEl`); the ribbon's settings button shows
  only while the left sidebar is collapsed. Clicking the switcher (again to
  close) opens a menu above it: the known vaults (`vaults.json` plus open
  windows, by name, a vault sharing its name with another labelled with the
  folder above it; the current one checked, a missing folder disabled), Open
  another vault… and Manage vaults…. Help runs `app:open-help` (justnotes' GitHub
  page through main's link policy; Obsidian's opens its own help), Settings opens settings. `app:open-vault`
  ("Open another vault") opens Manage vaults, as Obsidian's command opens its
  vault manager. Manage vaults (a modal, `.mod-vault-manager`, justnotes'
  own classes) lists the vaults with Open (Switch for one open in another
  window) and a menu with Reveal in Finder and Remove from list, Open folder
  as vault, and Create new vault (a name and a location, by default the
  current vault's parent folder). Main does every step: switching, revealing
  and removing take only a listed vault's path (`justnotes:switch-vault`,
  `reveal-vault`, `forget-vault`), opening goes through main's `openVault`,
  the same as `vault:open` and obsidian:// links. Open folder as vault takes
  the picked folder itself (`vaultFolderProblem`: an existing folder, not a
  disk's root, not inside a `.obsidian`), asks first for a folder not opened
  before (`confirmUnknownVault`, the dialog of files opened from Finder), and
  remembers it. Create new vault makes only the empty folder
  (`createVaultFolder`, names checked by `vaultNameProblem`: no separators or
  Windows-illegal characters, no leading dot or trailing dot or space) and
  opens it without asking, since it has no plugins. Remove from list rewrites
  `vaults.json` only (`forgetVault`, by real path), never touching the folder,
  and is refused while the vault has an open window.
- Vault picker (`main/vault-picker.ts`, page `src/picker/`: its own small
  html, css and script, built to `dist/picker.*`, not the app's stylesheet):
  the window a launch with nothing to open (no `--vault`, no file) shows
  instead of a folder dialog. One column: the icon and name, the known
  vaults as rows (name and `~` path; a missing folder greyed and not
  openable; on hover Reveal and Remove from list), a search field from six
  vaults, then Open folder… and New vault… (an inline form: name and
  location, by default the first vault's parent folder; Enter creates, but
  not while an input method composes). Keys: Up/Down, Enter, typing
  searches, Esc, Cmd/Ctrl+O and +N. It uses the vault switcher's IPC above
  and closes itself once a vault opens; closed without one, no window is
  left and the app quits. The system's light or dark colours, the icon's
  orange only on the main button and focus rings. A second launch with
  nothing to open brings it to the front.
- The macOS application menu keeps the standard roles (Edit, zoom, developer
  tools, window) but no accelerator on a key the renderer's hotkeys use: menu
  key equivalents fire before the page sees the key, so Electron's default
  menu made Cmd+W close the window and Cmd+R reload. Cmd+M is Quick LaTeX's.
  Windows and Linux have no menu.
- `require("electron").clipboard` is Obsidian's synchronous clipboard
  (latex-live's paste-as-table reads `readText` and `readHTML` in one go,
  `obsidian://new?clipboard` reads text). This Electron's renderer has none and
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
- Obsidian config files justnotes writes: `bookmarks.json` (see Bookmarks
  above), `app.json` and `appearance.json` (see Vault settings below), all
  three shared with Obsidian and synced by the owner's git. Never write any
  other file in `.obsidian` (`workspace.json`, `community-plugins.json`,
  `hotkeys.json`, `core-plugins.json`, `types.json`, ...). justnotes state
  lives in localStorage through
  `app.saveLocalStorage` (keys prefixed with the vault id): `justnotes-layout`
  (the layout, in `workspace.json`'s shape, with leaf ids; a vault without one
  starts from Obsidian's `workspace.json`, read only, else the default layout,
  because a plugin's side pane, placed once in Obsidian, lives only there; the
  command "Use Obsidian's layout for this vault",
  `workspace:load-obsidian-layout`, loads it over a saved layout), `enabled-plugins`
  (the Settings toggles, applied over `community-plugins.json`),
  `enabled-core-plugins` (the Core plugins toggles, over `core-plugins.json`),
  `latex-live-settings` (the LaTeX core plugin's settings), `justnotes-expanded` (explorer folders),
  `property-types` (property type changes made in justnotes, layered over
  `types.json`; an empty type unassigns one), `justnotes-editor` (the
  justnotes section of the Editor page, `editor-settings.ts`). The zoom
  level is the app's, in plain localStorage `zoom-factor` (Chromium shares
  the zoom between the windows of the page's origin). The language
  is localStorage `language`, else `en`; never the OS locale.
- Vault settings (`vault-config.ts`, tested; `Vault.getConfig`/`setConfig`):
  `app.json` under `appearance.json` is what `getConfig` reads, Obsidian's
  defaults (`DEFAULT_CONFIG`) for unset keys. `setConfig` (the settings
  pages, plugins, the CLI's theme and snippet commands) saves as Obsidian
  does: a value the key already reads (its default included) changes and
  writes nothing; otherwise `config-changed` fires with the key and the file
  is written 300 ms later (`saveConfig`, also in the quit flush), with
  `JSON.stringify(data, null, 2)`, keys in place (unknown ones included), a
  new key at the end, in the file that holds it, else where Obsidian keeps
  it (`APPEARANCE_KEYS` in appearance.json, the rest in app.json). A missing
  file is created only for a change. Every save reads both files first; a
  file changed on disk is merged key by key (the keys justnotes changed take
  its values, the others the file's). The files are re-read on their vault
  `raw` event (debounced 100 ms); `config-changed` (without a key) fires only
  when the settings changed, never for justnotes' own write. A file that
  does not parse keeps its last good settings, is never written, and the
  change waits (a Notice says so) until it parses. The theme and snippets
  are appearance.json's `cssTheme` and `enabledCssSnippets` (`CustomCss`
  follows them on `config-changed`).
- Settings window (`setting-modal.ts`): Options are General, Editor, Files
  and links, Appearance (`setting-options.ts`, Obsidian 1.14's names, order,
  tab ids `about`, `editor`, `file`, `appearance`, and keys), then Hotkeys,
  Core plugins and Community plugins. The four are declarative tabs whose
  control keys are vault settings (SettingTab's default
  `getControlValue`/`setControlValue`); derived choices map onto Obsidian's
  keys in the tab (`editingMode` is `livePreview`, `useWikilinks` the
  inverse of `useMarkdownLinks`, the attachment location and folder are
  encoded in `attachmentFolderPath`: `/`, `./`, `./name`, a path). Search
  re-reads the built-in tabs' definitions, so it finds every option. An open
  page redraws on a settings change from disk (a `config-changed` without a
  key), never for its own change, which would take the focus from a field
  being typed in. Other parts of justnotes add a group to the Editor page
  through `editorSections`; the justnotes section (selection scroll speed,
  pasted image format) is one. Every option shown changes behaviour live:
  - Editor (`editor-options.ts`, a per-editor compartment reconfigured on
    `config-changed`): line numbers, auto-pair brackets (CodeMirror's
    closeBrackets), auto-pair Markdown syntax (`markdownPairs`: `*`, `_`,
    `~`, `=`, `` ` ``, `$` or `%` typed over a selection wraps it), smart
    lists (lang-markdown's Enter and Backspace keys; off, Enter only breaks
    the line), spellcheck (the content's `spellcheck` attribute, default on;
    a misspelled word's menu offers `webFrame` suggestions and Add to
    dictionary), right-to-left (`dir` on the content and the reading view)
    and indentation guides (`cm-indent` marks on list indentation, a CSS
    border in the reading view's nested lists). Fold heading and Fold
    indent reconfigure the language and fold gutter (`languageConf`).
    Readable line length toggles `is-readable-line-width` on both views,
    Strict line breaks re-renders the reading view, Convert pasted HTML
    runs turndown (`htmlToMarkdown`) on pasted or dropped `text/html`, and
    Mod+Shift+V pastes plain text. Default view and editing mode apply to new
    tabs, as in Obsidian.
  - Files and links: Show all file types (`showUnsupportedFiles`, on by default
    in justnotes unlike Obsidian, so .json or .yaml files are never missed) off hides from
    the explorer, the quick switcher and link suggestions what justnotes does
    not open (`isSupportedExtension`: Markdown, TeX and plain text, images,
    audio, video, PDFs, canvases and bases always show, as do extensions a
    view is registered for); excluded files (`userIgnoreFilters`, a path prefix or a
    `/regex/`, managed on a sub-page) are left out of search, the graph and
    unlinked mentions and put last in the quick switcher and link
    suggestions (`excludedLast`).
  - Appearance (`renderer/appearance.ts`): the fonts set Obsidian's
    `--font-*-override` variables (00-base.css chains them before the
    theme's), the font size `--font-text-size`; Quick font size adjustment
    is Mod+wheel (or a pinch) by a pixel per 50 px of scroll, unless a view
    that zooms itself took the wheel; Show ribbon and Show tab title bar
    are body classes `show-ribbon` and `show-view-header`, as in Obsidian;
    the zoom slider sets `webFrame`'s zoom factor, and a zoom from the View
    menu is recorded on the next resize. Themes come from
    `.obsidian/themes` (no downloading); the folder buttons open the
    themes or snippets folder and never create it.
  - Left out because justnotes cannot honour them: vim key bindings (no Vim
    mode), spellcheck languages (Electron sets them only on Windows and
    Linux; macOS's checker detects the language), Show editing mode in
    status bar, Show inline title (justnotes has no inline title), Ribbon
    menu configuration, Native menus, Window frame style, Custom app icon,
    Translucent window, Hardware acceleration, Override config folder,
    Allow URI callbacks, Rebuild vault cache, automatic updates and the
    account.

## Terminal

- The Terminal core plugin (`src/renderer/terminal`, on by default) replaces
  the community plugin `terminal` (polyipseity), which keeps working in
  Obsidian. Views are `terminal` (state `{cwd}`: the shell's folder, followed
  through OSC 7, so a restored layout starts there); xterm.js 6 with the fit,
  WebGL (on context loss or failure, xterm's DOM renderer; xterm 6 has no
  canvas renderer), web-links, search and unicode11 addons.
- The shells are node-pty in main (`main/pty.ts`), not in the page: the page
  asks over IPC (`justnotes:pty-spawn`, `-input`, `-resize`, `-ack`, `-kill`;
  main sends `-data`, batched per 4 ms, and `-exit`), every pty belongs to the
  page that started it (popouts have no Node and go through their vault page)
  and is killed when its view closes, when that page navigates (reload) or is
  destroyed. Flow control: main pauses a pty while more than 100k characters
  wait for the page's acknowledgement of what xterm has written. The shell is
  the settings' shell, else the account's (as Ghostty), else `$SHELL`, with `-l`
  (PowerShell on Windows); its environment is main's without `ELECTRON_*`,
  with `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=justnotes`
  and `LANG=en_US.UTF-8` when no locale is set (a Finder launch). Never log
  the environment or config values; spawn errors name only the shell.
- node-pty is pinned to `1.2.0-beta.15`: Microsoft's package with prebuilt
  N-API binaries for macOS (arm64, x64), Windows (ConPTY) and Linux, so
  Electron needs no rebuild and no compiler (1.1.0's `spawn-helper` is not
  executable and every spawn fails). Bun trusts it by default, so its install
  script runs; it finds the prebuilds and builds nothing. Main loads it with
  `createRequire` on first use; it stays outside the bundle and the asar (see
  Packaging and releases). It produces no output under Bun, so its wiring is
  checked live only.
- Keys: the view's scope (no parent) lets through only hotkeys of
  window-level commands (`WINDOW_COMMANDS` in `keys.ts`: palette, switcher,
  settings, tabs, splits, sidebars, navigation), the `terminal:` commands,
  and on macOS any Cmd shortcut; everything else goes to the shell, as the
  plugin's "intercept keys when focused" does. A key the keymap handled is
  default-prevented, which the xterm key handler then drops.
  `terminalKeyAction` answers before both: macOS Cmd+C (with a selection),
  Cmd+V, Cmd+K (clear), Cmd+F (find), Cmd+A, Ghostty's default line keys
  (Cmd+Left/Right as ^A/^E, Cmd+Backspace ^U, Option+Left/Right ESC b/f) and
  Option+Delete ESC d (the owner's plugin keymap); elsewhere the Ctrl+Shift
  forms, and Ctrl+C copies only while text is selected. The macOS Edit
  menu's copy, paste and select-all reach xterm as DOM events.
- Links: URLs open with `window.open` (main's link policy); file paths a line
  names (`findPathCandidates`: tokens with a separator or an extension,
  `:line:col` allowed) resolved from the shell's folder (`vaultPathOf`) that
  are vault files open on click (Mod-click in a new tab). Explorer drags
  (`app.dragManager.draggable` files, action "Insert path") and system file
  drops paste the full paths, shell-quoted (`shellQuote`).
- Look (`appearance.ts`, `ghostty-config.ts`): Ghostty's config files as
  Ghostty loads them (`~/.config/ghostty/config[.ghostty]`, then macOS
  `~/Library/Application Support/com.mitchellh.ghostty/config[.ghostty]`,
  `config-file` includes after the naming file), read only and polled every
  2 s with `fs.watchFile`; else the theme's `--background-primary`,
  `--text-normal`, `--text-selection`, `--text-accent`, re-read on
  `css-change`. The xterm canvas is transparent (`allowTransparency`); the
  backdrop below draws the background colour at `background-opacity` over
  the pane and the image (a blob: URL, so popouts show it) with its opacity,
  fit, position and repeat. Mapped: font-family (with fallbacks),
  font-size, font-style/-bold weights, font-feature (as CSS, for the DOM
  renderer; WebGL never joins ligatures), adjust-cell-height (xterm refuses
  line heights below 1, so a negative one does nothing), background,
  foreground, selection colours, cursor colour, text, style and blink,
  palette 0-255, bold-color `bright`, minimum-contrast, macos-option-as-alt,
  window-padding-x/y, the background image options. Not mapped: a
  bold-color colour (xterm has none), keybind, font-family-bold/-italic,
  font-thicken, scrollback-limit (bytes; the settings take lines), window
  and shell-integration options. Every option a config may set gets a value
  in each look, so turning Ghostty off restores xterm's defaults. The
  backdrop is drawn only with "Ghostty's background" on (off by default):
  otherwise nothing is behind the text, and the pane shows, with any image
  a plugin puts on it. The view type is the community terminal plugin's
  (`terminal:terminal`), so plugins that treat terminals apart (the owner's
  `background` plugin and its terminal region) find these terminals; the
  view registers once the community plugin has gone.
- Settings (localStorage `terminal-settings`, the Terminal tab under Core
  plugins): shell, starting folder (vault or the active note's), Use
  Ghostty's config, Ghostty's background, font size, copy on select,
  scrollback. Commands:
  `terminal:open`, `-open-in-current-folder`, `-open-right`, `-open-below`,
  `-toggle` (Ctrl+`: into the last terminal, out of a focused one, or a new
  one below), `-clear`, `-find`, `-restart`; a ribbon button and "Open in
  terminal" in the file menu. Opening one (the ribbon, `terminal:open`, the file
  menu) puts it below the note, and later ones as tabs of that group. A view opened in a hidden tab opens xterm when
  first shown (it measures cells on open). Moved to a popout, xterm is opened
  again on its element (it follows the new window) and the WebGL addon is
  made again there. An exited shell shows a bar: Restart, Close, or Enter.

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
  `restart`, `quit`) in main; `completion` in the command. `restart`
  relaunches with the launch's options and a `--vault` for each open vault
  window (`restartArgs`), never the files or `obsidian:` URLs the launch
  opened. With no app
  running, a `vault` command reads the vault folder itself: `offline.ts`
  loads the app's own Vault, MetadataCache (reading, never writing, the
  profile's metadata cache, see Caches), MetadataTypeManager and
  InternalPlugins (core plugin options) in Bun, after
  `installLanguageExtensions()`, and writes nothing. When that cannot answer
  (no `file=` for an active-file default, a change such as `task toggle`) the
  handler throws `NeedsApp` and the command asks the app instead; every other
  command starts the app when none runs (from source `electron <repo>
  --vault <v> [--profile <dir>]`, needing `bun run build`; inside the
  packaged app its own binary, `appCommand`), detached, and waits for its
  socket, as Obsidian's first command launches Obsidian. Two commands
  starting the app together start one instance: the later start hands its
  vault to the first and exits. A start that exits without a socket coming
  up (it handed the vault to an instance that was quitting) is started again,
  at most every 2 seconds. `--offline` never
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
  synchronously). A connection that has not sent one complete request line
  within 10 seconds is closed (the command sends its request on connecting);
  once the request is in, it waits as long as the command runs. A window
  takes requests after `installCli` (end of boot)
  says it is ready; earlier requests wait up to a minute, and a reload, crash
  or close answers pending ones with an error. A socket file left by a killed
  instance is replaced on the next start. A socket that answers is left
  alone and the starting instance serves no CLI; under the single-instance
  lock only a process other than justnotes can be listening there.
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

## Code files

- Source and data files (`api/code-files.ts`: json, yaml, toml, C/C++, Python,
  Rust, Go, Java, TS/JS, CSS, HTML, shell, SQL... and Makefile-like names) that
  no view claims open in the code view (`renderer/code-view.ts`, view type
  `code`): a plain CodeMirror editor with line numbers, folding, search and the
  language from `@codemirror/language-data` (by file name, with a few aliases),
  saving through TextFileView. Workspace `openFile` falls back to it only after
  registered extensions and Markdown, so a plugin's view for an extension
  wins. Its tab shows the full file name. Code files count as openable for
  Show all file types. Any other unclaimed file opens there too when it is
  text (`isTextFile`: under 10 MB, no NUL byte and valid UTF-8 in its first
  8 KB), such as an uninstalled plugin's JSON board, which is highlighted as
  JSON when its text parses; only the rest goes to the system's default app.

## Packaging and releases

- Run from the repo (`bun run start`, scripts/start.ts, and the `justnotes`
  command run from source), macOS starts `node_modules/.cache/justnotes-dev/
  justnotes.app` (src/cli/dev-app.ts): a clone of Electron.app with
  `CFBundleName` justnotes, the app icon and an ad-hoc signature, remade when
  Electron or `packaging/icon.png` changes, so the menu bar and Dock say
  justnotes rather than Electron. scripts/smoke.ts keeps plain Electron.
- Electron is held at 44 (`44.9.3`, exact in devDependencies): on Electron
  45.2.0 a macOS input method (Pinyin and the like) does not compose in a
  `<webview>` (the omp sidebar) until it has composed once in the page
  itself; until then the keys arrive as plain letters. Under 44 it composes
  at once. Move to a newer major only after typing Chinese straight into the
  omp sidebar of a fresh window works there.
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
  page require at runtime, and node-pty (unpacked: `asarUnpack`, since its
  `.node` files, `spawn-helper` and Windows worker cannot run from inside
  the asar); every other dependency is bundled by esbuild or copied into
  `dist/lib` (MathJax, pdf.js, Mermaid, Prism). A new runtime `require` of a
  package needs an entry in `files`. node-pty, the one native module, ships
  prebuilt N-API binaries, so nothing is rebuilt (`npmRebuild: false`). Its
  `prebuilds/{darwin,win32}-${arch}` both go into every package: a
  platform-level `files` entry never reaches node_modules, and `${platform}`
  is the building machine's when cross-building. Nothing reads the repo at runtime:
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
- Markdown and TeX files: the macOS app declares `.md`, `.markdown` and
  `.tex` as an Alternate Editor (offered in Open With, never taking the
  default app; the owner's environment, myrunbook's `--finder-only`, makes it
  the default for `.md` and `.tex`);
  Windows declares no association, because NSIS would make justnotes the
  default `.md` handler. A file arrives as `open-file` (macOS, at launch
  before `ready`, and while running, since macOS hands a running app the
  file instead of launching it again) or as an argument (any platform; a
  second launch hands its own to the running instance); `openFile` in `main.ts`
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
  `--args --profile <dir>`; without one it uses the real default profile
  (and with that profile's instance running, hands it the file). With the
  package already running on a test profile, macOS sends the file to it.
- CI (`.github/workflows/build.yml`, actions pinned by commit): on pushes
  and pull requests to main, macOS (macos-15) runs `bun install
  --frozen-lockfile`, `bun run check`, `bun test test`, `bun run build` and
  packages; Windows (windows-2025) checks, builds and packages without the
  tests, which assume POSIX (Unix sockets and file modes, symlinks, bash
  completion). Bun's cache and the Electron and electron-builder downloads
  are cached; the packages are workflow artifacts (`justnotes-macOS`,
  `justnotes-Windows`). A push to main then publishes them as the latest
  GitHub Release, tag `main-<version>-<commit7>` made on the built commit
  (`publish` job; a tag pushed with the workflow token starts no run).
- Installing on the owner's machines: `bun scripts/install.ts`. macOS builds
  the checkout (`--mac --dir` for the host arch), swaps it into
  `/Applications/justnotes.app` by rename, re-registers it with Launch
  Services (its document types) and links `~/.local/bin/justnotes` to the
  bundle's launcher. Windows downloads the latest release's `-win-x64.zip`
  into `~/Downloads/justnotes-<tag>/` and swaps it into
  `%LOCALAPPDATA%\Programs\justnotes` (the last install stays as
  `justnotes.previous`), with a `~/.local/bin/justnotes.cmd` shim. Both
  refuse while the installed app runs. The profile (vaults, layout, the
  built-in plugins' settings) is outside the app and survives every install.
- Release: bump `version` in package.json, commit, tag `v<version>` and push
  the tag. The workflow checks the tag matches package.json and creates a
  draft GitHub Release with the `.dmg`, `.zip` and `-setup.exe` files and
  generated notes; publish it by hand.

## TeX and text notes

- In Obsidian only Markdown is a note; in justnotes `.tex` and `.txt` are
  notes too. `api/note-files.ts` is the one place that says so
  (`NOTE_EXTENSIONS`, `isNoteFile`, `fileDisplayName`, `isIndexedNote`); use
  it instead of `extension === "md"` wherever a feature means "a note".
  Where plugins look, Markdown keeps Obsidian's meaning: `getMarkdownFiles`,
  `MarkdownView`, `workspace.activeEditor`, frontmatter, tags and
  properties are Markdown's only.
- What "note" covers: the metadata cache (`metadata-text.ts`: a TeX file's
  `\part`..`\subparagraph` are headings, the outermost command at level 1,
  comments, verbatim environments and `\iffalse` blocks skipped; its
  `\input`, `\include`, `\subfile` and `\import` are links, `.tex` added
  to a name without an extension; a text file's wikilinks are its links), so
  `[[main.tex]]` resolves and counts as a backlink, a root links to its
  chapters and the outline pane lists a TeX file's sections (it follows the
  cursor of any view with a CodeMirror `editorView`); search (pane and CLI;
  a `tag:` query reads Markdown only); graph nodes; File recovery; the word
  count (a TeX note counts `texText`, the text TeX typesets); the New note
  menus (folder menu New TeX file / New text file, commands
  `file-explorer:new-tex-file` / `file-explorer:new-text-file`, both making
  `Untitled.<ext>` like New note); the explorer and link suggest show their
  whole names with no badge; the CLI's `outline`, `wordcount`, `search`,
  `deadends`, `random` (`note()` in `cli/commands/context.ts`; `read`,
  `append`, `prepend` took any file already; `prepend` keeps a frontmatter on
  top only in Markdown). TeX and text files over `TEXT_NOTE_INDEX_LIMIT`
  (2 MB: courses holds hundreds of MB of `.txt` data) open as notes but are
  never read for the cache, search, graph texts or snapshots.
- Renames rewrite TeX `\input`-like paths as TeX reads them (`texRelink`
  in `metadata-text.ts`): relative to the source's folder when the old path
  resolved from there (the new folder then: a moved root), else to the
  folder where the old target's path ends with it (TeX reads from the root
  document's folder, so a chapter's root-relative `\input` stays
  root-relative), keeping a missing `.tex` and quotes. The lenient link
  resolution cannot tell whether a TeX path still works, so a TeX link is
  rewritten exactly when this computation changes it. `\import` paths are
  left alone.
- `.txt` opens in `PlainTextView` (`plain-text-view.ts`, view type
  `plain-text`): CodeMirror with no language, soft wrap, the readable line
  width, history, search, multiple cursors; it saves through TextFileView.
  Its `textEditor` is an `Editor`, deliberately not its `editor`, so it never
  becomes `workspace.activeEditor` (plugins take that to be a MarkdownView);
  core editor commands registered with `plainText: true` (swap line
  up/down, delete paragraph, add cursor above/below) act on it through
  `Commands.#editorFor`. `.tex` has no fallback view while the LaTeX core
  plugin is off and the community latex-live is not loaded.
- The LaTeX core plugin (`latex`, `src/latex/latex-live.ts`, class
  `LatexLive`, installer `LatexLive.install`) is obsidian-latex-live built
  in: the TeX editor and live preview, texlab completion and hover,
  snippets, diagnostics, compiling, the PDF preview with SyncTeX both ways,
  the project outline, HTML export, bibliography, prose and project tools,
  template visualization, its commands and settings. It is justnotes' own
  core plugin (`JUSTNOTES_OWN` in `internal-plugins.ts`): on unless turned off
  on the Core plugins page, whatever core-plugins.json says. Its options page
  is listed under Core plugins in the settings window
  (`CorePluginHost.addSettingTab`, `SettingModal.coreTabs`; the Core plugins
  row has an Options button). Settings live in localStorage
  (`latex-live-settings`); the first load without them reads the vault's
  `plugins/latex-live/data.json`, never written. Command ids and names stay
  the community plugin's (`latex-live:compile`, "LaTeX Live: ..."), view
  types too (`latex-live-editor`, `latex-live-preview`), so hotkeys.json and
  saved layouts carry over. The `latex-live:api-ready` workspace event fires
  once the layout is ready (community plugins have loaded) or at once on a
  toggle, with the `LatexLive` instance: kgdistiller attaches its markers to
  the TeX editors through `registerTexEditorExtension` on it. Builds go to
  `$TMPDIR/justnotes-latex/<hash>`, apart from the Obsidian plugin's
  `obsidian-latex-live`, so both apps can have the same project open.
- While the LaTeX core plugin is on, the community plugin `latex-live` is
  not loaded (`REPLACED_BY` in `plugins.ts`, `Plugins.replacedBy`): both
  would register the same views, extensions and commands. The Community
  plugins list says so on its row, with the toggle disabled; turning the
  core plugin off loads the community plugin again when it is enabled, and
  turning it on unloads it first. In Obsidian the plugin keeps working
  unchanged. `smoke.ts` reports such plugins as `replacedPlugins`.
- Pasting an image into a `.tex` editor (`src/latex/editor/imagePaste.ts`,
  justnotes' own) saves it through `importFile` (attachment folder rules)
  and opens a form: the path as `\includegraphics` takes it (relative to the
  root document's folder), width as a fraction of `\linewidth` (presets 1,
  0.75, 0.5, 0.33), caption, label (`fig:` and the file name), placement,
  figure environment or bare. Enter inserts at the cursor; Escape (any close)
  inserts the bare `\includegraphics` with the chosen width, since the image
  is already saved. Pasted text stays plain.
- `src/latex/` came from github.com/qiulinfan/obsidian-latex-live at
  7cf29c7aa76f66afb2d8845ef987ad6e0fdd1537 (release 0.2.0), imported
  unchanged and then adapted: imports of `obsidian` point at justnotes'
  modules (`src/api/*`), `main.ts` became `latex-live.ts` registering through
  the core plugin host, the missing-styles notice, the named New TeX file
  dialog and the headless kgdistiller export bridge (`kgdistillerBridge.ts`,
  `nodeHost.ts`) went. Everything else keeps latex-live's own conventions,
  which its AGENTS.md at that commit states (`git -C
  ~/Desktop/projects/obsidian-latex-live show 7cf29c7:AGENTS.md`): `tex/`
  free of UI code and tested against real TeX, `keyArbiter` first and the
  only owner of Tab/Enter/Escape/arrows, edits reaching saves, compiles and
  texlab only through `editNotifier`, `runTex` for every TeX process, the
  live preview's single StateField, `ProjectMath` never touching the global
  MathJax's definitions, `src/editor/shared/` shared with obsidian-tinymist.
  Bring later upstream changes in the same way: a commit naming the
  upstream commit, applying `git diff 7cf29c7..<new> -- src tests styles.css`
  to `src/latex`, `test/latex` and `93-latex.css`.
- Tests: `test/latex/` is latex-live's suite under `bun test` (its
  `node:test` tests run as they are). Many run real TeX, texlab and
  MathJax, so `bun test test` takes about 4.5 minutes with TeX installed
  (they skip without it); `bun test $(ls test/*.test.ts)` runs justnotes'
  own in seconds. Bun's transpiler escapes non-ASCII characters inside
  `String.raw` templates, so tests interpolate them (`${"第"}`); bun's
  per-test timeout is 5 s, so slow tests pass node:test's `timeout`. Tests
  that need dvisvgm skip without it (Homebrew's TeX Live has none; they fail
  the same way upstream). Not ported: the tests of Obsidian glue written
  against latex-live's Obsidian stand-in, the release and styles checks.

## Views, files and saving

- TextFileView saves through `vault.process`, so reading, merging and writing
  are one step and a plugin's concurrent write is merged, not lost. An outside
  change to an open file merges line by line with unsaved edits (`mergeText`,
  a line diff3), including lines one side added next to a line the other side
  changed; a real conflict keeps both versions and shows a notice. Line breaks
  compare as LF and the result takes the file's (a CRLF note converted to LF
  while open merges cleanly and saves as LF; MarkdownView re-detects CRLF from
  the text a reload or merge sets, `crlfOf`). The take-in
  during a save, the reload on vault `modify` and the quit flush all merge
  this way. A view whose text is structured data registers its own merge with
  `mergeWith` (the canvas merges by node and edge id, field by field, so a
  merge never yields broken JSON; a field changed on both sides takes the
  file's value).
- For a second after a save the document remembers the text the save replaced
  (`prior`), for QuickAdd's capture, which reads, computes and then writes:
  merged against the save, it would undo it. `mergeBase` merges a change
  against the replaced text only when the change is that text with lines
  inserted (an inserted line may fill a blank one) or with text inserted
  inside lines (QuickAdd's inline insert; `insertsText`), merges with the save's
  edits without a conflict, is no version the document has had (`seen`: every
  text it loaded, saved or took in) and was not made from the saved text
  (holding all its lines: QuickAdd reading after the autosave, a line appended
  without a final newline). Every other change, a revert to any version the
  document has had included, is merged against the saved text and wins. The
  comment on `mergeBase` has the exact rules.
- Limits of judging by content: a revert to a version from before the note was
  opened, landing within the second, passes for a capture when the replaced
  text is that version with lines removed or emptied (or text removed inside
  lines), and the save's edits survive it. A rewrite of only lines the save inserted (a formatter tidying
  the line just typed) is byte for byte a capture, so the typed line is kept
  beside its rewrite once; the write that saves it records no `prior`
  (`keptCapture`), so a writer that rewrites on every save does not grow the
  note. After a save that only removed the final newline, a line appended
  within the second loses its own. QuickAdd's inline insert into the very
  line the racing save changed conflicts with it line by line, so the insert's
  version of that line wins and the save's change to it is lost (its other
  edits stay).
- Vault writes go in place, never to a temp file renamed over the note: a
  rename resets the birth time (Bases `file.ctime`), the inode, the mode and
  xattrs such as Finder tags. A read of a path waits for a write putting that
  file's bytes on disk; reads never wait for queued writes, because code inside
  the write queue (kgdistiller's reconcile hooks) may read.
- `fileManager.renameFile` also follows raw HTML media srcs (`<img>`,
  `<video>`, `<audio>`, `<source>`; `html-links.ts`), which the metadata
  cache does not index (Obsidian leaves them broken): a relative src that
  named a moved file exactly (relative to its note, backslashes, `./` and
  %-escapes read as Typora writes them), and every relative src in a moved
  note, is rewritten relative to the note, keeping `./`, %-escapes and
  backslash style. Absolute paths, URLs, srcs that only found their file by
  name and anything in code or comments are left alone. Only notes holding
  a moved file's name are read.
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
  them in the layout. A beforeunload handler that keeps the page (a
  plugin's; Electron shows no dialog, `will-prevent-unload`) cancels the
  close and any quit in progress: the page has already let go of its
  popouts, so main closes the ones it held (`unloadCancelled`), the page
  saves its layout again and the next close flushes again. New tabs, splits and `getLeaf(false)` follow the active leaf
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
  popout there. A tab drag ends on its drop, and in every window also on any
  dragend, the start of another drag, a pointer press, or a dragover or drop
  that carries no tab: the dragged header's dragend never comes once a drop
  in another window has moved it there. Moves go through `removeChild`/`insertChild`, so
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
  whole, and so is a map whose line-wise edit would leave an alias (`b: *x`)
  without its anchor or change another property's value (aliases resolved
  to their values, as Obsidian's own rewrite does); every edit's result
  parses. Removing the last property removes the block. YAML that does not
  parse to a map shows "Invalid properties", which opens the YAML.
  `fileManager.processFrontMatter` (QuickAdd, Bases cells) applies what its
  callback changed the same way, property by property, and throws on YAML
  that is not a map rather than replacing it. A Bases cell edit it refuses
  (`writeCell`) shows the reason in a Notice and puts the cell back.
- While Daily notes is on, a date or date & time property links to its day's
  daily note, as Obsidian's date widget does: the date shows in the link
  colour, a click on its text opens the note (made from the daily note
  template when missing; Mod-click in a new tab) through the plugin
  instance's `openDailyNoteOf`, which the installer sets and removes; the
  calendar icon, a click beside the text and the keyboard edit the value.
  `color-scheme` follows the theme on `body`, so native date pickers (their
  calendar icon), checkboxes and scrollbars are dark on the dark theme in
  properties and plugin views alike.

## Caches

Derived data kept between runs lives in the profile (Electron's `userData`,
`--profile`), never in the vault, and is only ever a shortcut: a missing,
stale or corrupt cache gives the same result, more slowly.

- Metadata (`metadata-store.ts`): `<profile>/metadata-cache/<id>.jsonl`, `id`
  a hash of the vault's real path (the app and the offline CLI may spell it
  differently). A header line (`version`, `vault`), then one line per note:
  `[path, mtime, size, CachedMetadata]`, the parse of the note's text when the
  file had that mtime and size, with every position packed as six numbers
  (frontmatter is left as it is). At startup a note whose stat matches its
  line is not read; every other note is read and parsed as before, and links
  are resolved for all of them. The stat recorded is the one taken before the
  read, so a note written during the read is parsed again next time. The app
  writes the file 3 s after a start that parsed any note (copying the lines
  of unchanged notes as read) and when the window closes (boot.ts, after the
  views are saved), written beside and renamed over; after a crash or a
  reload, the notes changed since are parsed at the next start. A note whose
  metadata would not survive JSON (YAML's `.inf`, binary) is left out and
  parsed on every start. The offline CLI reads the file of its `--profile`
  and never writes it. Bump `METADATA_CACHE_VERSION` whenever
  `parseMetadata`'s output changes for some text (the digest test in
  `test/metadata-store.test.ts` fails until a new digest is added under the
  new version); otherwise notes keep their old metadata until edited.
- Compiled code (`code-cache.ts`): V8's code for scripts the app evaluates,
  since Chromium caches code only for scripts fetched over http(s).
  Plugins: `<profile>/code-cache/plugins/<id>-<hash>.bin`, the hash of the V8
  version and the wrapped `main.js` text. `Plugins.#instantiate` compiles the
  wrapper with `vm.Script` (in the page's global scope, as the indirect eval
  before it did) using that file when present, and writes it after the
  plugin's `onload` (so it holds what loading compiled) when it was missing or
  V8 rejected it; an older text's file of the same plugin is removed then.
  The renderer: `index.html` loads `loader.js` (`src/renderer/loader.ts`),
  which runs `renderer.js` the same way from `<profile>/code-cache/renderer-
  <hash>.bin` (hash of V8, the bundle's size and mtime), written 3 s after
  layout-ready when it was missing or rejected. Packaging must ship
  `loader.js` beside `renderer.js`.
- Startup leaves those notes' texts unread, so the vault's text cache
  (`cachedRead`) fills on the first search, unlinked-mentions scan or graph
  content query; they read through `readInOrder` (`read-in-order.ts`), up
  to 16 reads under way, in order.

## Live Preview and math

- Decorations are one `StateField` rebuilt from the syntax tree on doc,
  selection or tree changes. Block math needs a state field (view plugins
  cannot replace line breaks). Typing on a 5500-line note stays within a frame.
- Reveal rule: inline syntax shows while any selection touches the element;
  line syntax (heading marks, quote marks, list bullets, tasks, rules, block
  math) shows while the selection is on those lines.
- `editorLivePreviewField` false means Source mode: no decorations at all.
- Paths with bare spaces, as Typora writes them (`![shot](a.assets/Screenshot
  2025-02-09 at 15.04.04.png)`, `[N](My Note.md#Part one)`), are links and
  images in all three parsers (reading view `spaced_link`, Live Preview
  `spacedLinkSyntax`, metadata `SPACED_MDLINK_OPEN`), though CommonMark leaves
  them text. One rule decides (`spacedDestination`): the path ends in a file
  extension (maybe with a `#subpath`, or a `:line[:col]` as agents write
  citations) and is not `url "title"`, so prose in parentheses stays prose.
  `spacedLinkEnd` finds the closing `)` for all three: escapes skipped,
  unescaped parentheses nested, and when that never closes (a path escaping
  only its `)`: `08(Transport from Paradise\)/a.md`) the first unescaped `)`.
- Link paths as agents and terminals write them (`filePathLink`): when a
  link does not resolve as written, an absolute file system path inside the
  vault resolves to that vault file (Obsidian would read it from the vault's
  root), and a `:line[:col]` after the file name resolves to the file and
  opens it at that line (`openLinkTextIn` passes `eState.line`), never
  creating a note named after the link.
- Links as Obsidian renders them: a destination is read as CommonMark reads
  it (`destinationText`: no angle brackets, backslash escapes unescaped, so
  `[x](a\_b.md)` opens `a_b.md`); reference links (`[text][ref]`,
  `[text][]`, `[text]`) render with the destination of the note's definition,
  found in the same tree pass and applied after it; one whose label the note
  never defines is plain text, brackets included, cursor on it or not
  (`cm-unresolved-reference`, checked against the whole note's definitions),
  as `[static hissing]` and `[00:23:58–00:24:01]` read in Obsidian. The
  editor's Markdown drops GFM's `:shortcode:` Emoji parser, which Obsidian
  does not have and which took a timestamp's `:23:` for one; reference images
  (`![alt][ref]`) take theirs from `referenceDefinitions`, computed once per
  state; a definition line shows its label small (`cm-link-ref-label`) and its
  destination as a link.
  Ordered tasks keep their number before the box (a bullet gives way to it),
  in both views. Footnote references (`[^1]`) show their source as a faint
  superscript (`sup.cm-footref-rendered`); a definition's `[^id]: ` becomes
  the footnote's number as the reading view counts it (references by first
  use, inline `^[notes]` included; the label when nothing refers to it).
- Raw HTML: an `<img>` alone or inline becomes an `HtmlImageWidget` (its src
  found as the reading view finds it); any other HTML block (`<p
  align="center">`, `<div>`, `<details>`, ...) renders through
  `MarkdownRenderer`, sanitized like the reading view, as a block widget
  (`.cm-html-embed`) until the selection enters its lines.
- Double-clicking an image opens the image menu (`image-menu.ts`). Size:
  presets (100, 75, 67, 50, 33, 25%) and Reset size rewrite an `<img>`'s
  `zoom` style (only its value, keeping its spacing, the other declarations
  and attributes; a missing style is added before the tag's end; reset
  removes the zoom and an emptied style attribute), a wikilink's `|W` or a
  Markdown image's `alt|W` (W from the image's `naturalWidth`, replacing a
  `WxH`; reset removes it). Alignment (left, center, right, Reset
  alignment) is an `<img>` style, `display:block; margin:0 auto` (center),
  `margin:0 auto 0 0` (left), `margin:0 0 0 auto` (right), replacing any
  display and margin declarations: the reading view, Live Preview and
  Obsidian (which keeps inline styles) render it alike, while `<p
  align="center">` would make Live Preview render an HTML block with no
  image widget. Embeds have no alignment syntax in Obsidian, so aligning one
  first turns it into an `<img>` (`embedAsHtml`: src relative to the note,
  its size as width/height attributes, its alt text or else the file's
  name as alt). Live Preview hides CodeMirror's widget buffers beside such
  a block image (`80-live-preview.css`), which would add an empty line
  above and below it. Size and alignment are one undoable change each on
  the editor's document. Rename image... (the explorer's `PromptModal`, the
  extension kept) and Move image to... (its `MoveModal`; both in
  `ui/file-modals.ts`) save the note, then go through
  `fileManager.renameFile`, so wikilinks, Markdown links and `<img>` srcs
  follow (see Views, files and saving); they are disabled for an image that
  is no vault file. Live Preview handles its own image widgets
  (`.image-embed` and `.cm-html-embed` images outside rendered blocks; the
  widget's `posAtDOM` finds the source): a press on one is taken from
  CodeMirror, and a single click reveals the source only after 300 ms, or
  the second click of a double click would land on revealed text. The
  reading view finds the source of a double-clicked image in its section's
  text by the URL each image loads and their order (`refForRenderedImage`),
  skips images of embedded notes and anything whose source changed since
  the render, edits like a task tick, re-renders and saves. Images inside
  Live Preview's rendered blocks (callouts, tables, HTML blocks) get no
  menu.
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
  continues quote or list markup, so `continueQuotedCode` (bound after
  `exitEmptyQuote`) starts a new line in a fenced block inside a quote with the
  line's quote marks and the whitespace after them, as Obsidian does, also on
  an empty code line.
- Lists (`editor-lists.ts`, tested in `test/editing-lists.test.ts`) read the
  text as CommonMark does: tab stops every 4 columns counted from the line
  start (so after `> ` a tab reaches only column 4), children at or past the
  item's content column and less than 4 past it, lazy continuation lines, and
  a new ordered list interrupting a paragraph only from 1 (a nested `2.` right
  under its parent's text is text). `scanLists` starts at the top-level block
  around the cursor (from the syntax tree, which knows code and frontmatter)
  and reads one quote depth. Tab and Shift+Tab on an item's marker line (or a
  selection of items) move the item with its children: under the previous
  sibling's content column (joining children it already has), with tabs to
  the first tab stop at or past it (two tabs under `100. `); Shift+Tab to the
  parent's level, the siblings after it becoming its children. The first item
  of a list and a top-level item stay put; other lines, and Completr's open
  suggestion (its scope runs first), keep their Tab. Indentation follows the
  list's own lines, the vault's `useTab` only for a flat list. Enter continues
  the item (same bullet, next number and delimiter, `[ ]` for a task, loose
  lists stay loose), splits it mid-text, adds an empty item above at the
  start of its text, makes the first child when the item has children (after
  them when folded); on an empty item it moves out one level, and at the top
  level ends the list below a blank line so typed text is no lazy
  continuation. Shift+Enter adds a line at the content column. Backspace at
  the start of an item's text removes a task box, then moves an empty item
  out (or removes its marker at the top level), or makes the text a
  continuation of the item above (a paragraph with none). `listRenumbering`,
  a transaction filter, renumbers in the same transaction (one undo step)
  every ordered list whose items changed, after user edits that add or remove
  line breaks (Enter, cut, paste, Alt+arrows) or carry `listEdit` (list keys,
  toggles through `runEdit(..., true)`): from the old first number, a list
  split off keeping the number it shows, a newly nested list from 1, pasted
  items keeping theirs; a number gaining a digit moves the item's lines to
  its new content column. Typing within a line and edits without a user
  event (reloads, plugins) are never renumbered.
  Enter, Shift+Enter, Backspace and renumbering follow "Smart lists"
  (`smartIndentList`, editor-options.ts; canvas card editors read it when they
  open); Tab and Shift+Tab on items always move them.
- Only heading sections (`foldHeading`) and what is nested in list items
  (`foldIndent`) fold, as in Obsidian: `markdownSupport` strips lang-markdown's
  block folds and the folds of every language it mounts: fenced code
  (`foldless`), HTML in notes and in `html`/`xhtml` fences (elements, script
  and style contents, `style` and event-handler attribute values), and
  `markdown` fences (CommonMark without lang-markdown's folds, so their
  headings are no sections). Vue, Angular, PHP, Liquid and Jinja fences nest
  HTML, CSS and JavaScript through private parsers that share the exported
  languages' node types, so `deeplyFoldless` wraps their parser: each parsed
  tree's mounted trees are copied with fold-free node types
  (`foldlessMounts`); those inner trees are parsed again on each change.
- Scripts and styles in a note's HTML parse by their type or lang exactly as
  lang-html decides, at once: `editor-extensions.ts` copies lang-html's
  nesting rules with fold-free parsers, including its private list of event
  handlers (from 6.4.12; recheck it when upgrading lang-html). Other types,
  such as `math/tex`, stay text. Fences match language-data by name or alias,
  not extension: `md` and `htm` fences stay plain.

## Editor settings

- The Editor page's last section, justnotes, holds justnotes' own options
  (`editorSettings(app)` reads them live, so a change applies at once);
  Obsidian's editor options above it are saved in app.json.
- Selection scroll speed (1 to 10, default 5; `selection-scroll.ts`): while
  a drag-select is at or past the top or bottom edge of what scrolls
  (counting from 10 px inside it, so a note reaching the bottom of the screen
  still scrolls), a frame loop scrolls at `selectionScrollSpeed`: at 5 about
  1100 px/s at the edge, 3100 at 30 px past, 12000 at 120 px past, linear in
  the setting. CodeMirror's own is 160, 570 and 1800 (a 50 ms interval of
  0.7 px per px past + 8), Chromium's in the reading view 1300, 4900 and
  11800. In editors `editorSelectionScroll` takes over CodeMirror's vertical
  scrolling: it reaches into the internal mouse selection
  (`view.inputState.mouseSelection`, @codemirror/view 6: `setScrollSpeed`,
  `select`, `lastEvent`, `dragging`, `scrollParents`), turns off its vertical
  speed and extends the selection through its `select(lastEvent)` after each
  step, as CodeMirror's own scroll does; recheck these names when upgrading
  @codemirror/view (without them CodeMirror's scrolling is left alone). In
  rendered Markdown outside editors (reading view, hover previews)
  `installNativeSelectionScroll` (every window) does the same for the native
  selection: once a press has dragged a selection, the scroller gets
  `.is-selection-scrolling` (overflow-y hidden) until release, which is the
  only way found to keep Chromium's autoscroll off it (cancelling mousemove
  does not), and the selection's focus moves to the text at the edge
  (`caretPositionFromPoint`) after each step. Measure with real CDP mouse
  events (press, moves past the scroller's edge, scrollTop over a held
  second); the frame loop needs the test window shown.
- Pasted and dropped images as (`html` default, `wikilink`, `markdown`;
  `imageLink` in `attachments.ts`): an image file pasted, dropped from
  outside or dragged from the explorer into a note is written as Typora
  writes it and as the owner's notes hold it, `<img src="<path>"
  alt="<name>" style="zoom:100%;" />` with the src relative to the note,
  forward slashes, spaces kept (only a `"` is %-escaped) and the file's
  basename as alt; or `![[linktext]]`, or `![](linktext)` with the
  destination encoded as `generateMarkdownLink` encodes it, both following
  `newLinkFormat` whatever `useMarkdownLinks` says. Other files keep
  `generateMarkdownLink`. Pasted files are still saved by `importFile` into
  the attachment folder.

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
  ribbon `--ribbon-*`, the status bar `--status-bar-*`, the vault profile
  `--vault-profile-*` and the nav item radius and hover, icons `--icon-size`
  and `--icon-stroke` set on their container. docs.obsidian.md names the
  component variables without values; `00-base.css` holds the default
  theme's, as themes restate them. A row's collapse chevron sits in its left
  padding, over the children's indentation guide, so file and folder names
  line up. State classes are Obsidian's, for themes: a collapsed explorer
  folder has `is-collapsed` on its `.tree-item` and its `.collapse-icon` (one
  down arrow the stylesheet turns aside), the left ribbon `is-collapsed`
  (and `--ribbon-background-collapsed`) while the left sidebar is
  collapsed. Search results are tree rows: `.tree-item.search-result` with a
  title row (basename, chevron folding the matches, match count as flair;
  the path is its tooltip) and `.search-result-file-matches` below.
- Main-area tabs are `--tab-width` (200px) wide, as Obsidian's, and shrink
  evenly when they no longer fit, down to their icon; past that the tab bar
  scrolls. The width is a `width`, not only a flex basis: a flex container's
  intrinsic size counts its items' content, so a basis alone squeezed the tabs
  to their titles beside free space.
- Links take their colours from the `--link-*` variables, and a base `a` rule
  gives plain anchors in plugin views the link colour. Live Preview's link
  marks carry `.internal-link` and `.external-link`, so the reading view's link
  rules style them too.
- Host overlays sit on the same `--layer-*` scale as Obsidian's (status bar,
  popover, modal, notice, menu and suggestion, tooltip). Each `.cm-editor`
  isolates its stacking, so CodeMirror's own panel (300) and tooltip (500)
  z-indexes stay under host overlays. A leaf showing a CodeMirror tooltip goes
  above the other leaves (`z-index: 1`), so a tooltip that reaches past its
  pane (a plugin's completion docs and hovers beside its preview pane)
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
(0.1.5 and 3.0.2), latex-live (0.1.0, 0.1.7 and 0.2.0; now replaced by the
LaTeX core plugin while that is on), obsidian-git (2.41.1
and 2.42.0), omp-sidebar, quickadd (2.24.2 and 2.33.1), terminal (3.27.2 and
3.29.0; not loaded while the Terminal core plugin is on). QuickAdd's capture into the active canvas and into a configured
card were tested on a synthetic vault. In a popout window Markdown editing,
Completr's and the link suggests, latex-live's math, QuickAdd's modals and
menus and a terminal moved there (its `onWindowMigrated` reopens xterm) were
tested live. All twelve, translate (0.1.0) included, also loaded with no
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
blogs with five of its plugins. The settings pages (every Editor, Files and links and
Appearance option applied live, app.json and appearance.json written,
merged with outside writes, a broken file left alone) were tested live on a
synthetic vault and on a copy of blogs with five of its plugins.

## Verify

- `bun run check` (TypeScript), `bun run build`, `bun run test`; after a
  change to packaging, main's startup, the command or the terminal's pty,
  `bun run dist:mac` and the package checks in Packaging and releases (for
  the terminal: open one in the packaged app and run `echo`, which proves
  node-pty loaded from `app.asar.unpacked`).
- Test against a copy of a vault, never the owner's real vaults:
  `bun scripts/test-vault.ts <vault> <dest> [plugin-id ...]`. Plugins write
  their `data.json`, and some run external programs. The copy holds no link
  that points outside it: a plugin folder can be a symlink to the plugin's
  development checkout, whose `data.json` is the real one, and the script
  copies such a folder as files.
- `bun scripts/smoke.ts --vault <copy> --port <port> --profile <dir> [--keep]
  [-- <electron flag> ...]` launches an isolated instance (own profile, mock keychain, no background
  throttling) and reports boot errors. It passes `--background`, so the
  instance never takes the owner's focus: windows show inactive and, on macOS,
  the app stays an accessory (no Dock icon, never activated). Any other
  test launch of Electron (benchmarks, A/B runs) passes `--background` too.
  Drive a kept one with
  `CDP_PORT=<port> bun scripts/cdp.ts` (real key events, `eval` against
  `window.app`, screenshots, `reload`; always set `CDP_PORT`, or it drives
  whatever listens on 9333; it attaches to the first vault page, and
  `CDP_POPOUT=<n>` to the n-th popout window for keys and screenshots; `eval`
  in the vault page reaches popouts' documents). A real tab drag needs
  `Input.setInterceptDrags` and `Input.dispatchDragEvent` on the target page;
  a page whose popout closes on the drop stops answering. Mouse input goes through `Input.dispatchMouseEvent`. Injected keys
  never trigger macOS menu key equivalents, so Cmd+A needs `cdp.ts selectall`;
  native `<select>` popups cannot be driven. A plugin's `<iframe>` from
  another origin (a preview served on 127.0.0.1) is a target of its own
  (type `iframe` in `/json`): read positions inside it through that target,
  then click at them in page coordinates.
- Stub openers before clicking anything that may open a URL. Assigning
  `require("@electron/remote").shell.openExternal` patches only the renderer
  proxy; evaluate in main instead (`remote.require("vm").runInThisContext`
  with `process.mainModule.require("electron")`). Stubs in main survive
  `cdp.ts reload`; the page's do not. The vault switcher's folder pickers,
  its confirmation and Reveal in Finder are main's `dialog.showOpenDialog`,
  `dialog.showMessageBox` and `shell.showItemInFolder`: replace them there
  before clicking (a native picker cannot be driven and would open on the
  desktop). Closing the window `cdp.ts` is attached to (the first vault
  page) leaves the command waiting.
- Never record the real microphone or raise macOS's microphone prompt: pass
  `-- --use-fake-device-for-media-stream` to `smoke.ts` (flags after `--` go
  to Electron), which gives getUserMedia Chromium's synthetic input and makes
  main skip the system check. Not `--use-fake-ui-for-media-stream`: it
  grants every media request before main's permission handler sees it.
- Never touch the system clipboard: intercept `navigator.clipboard` in the
  page and replace main's clipboard with one in this Electron's asynchronous
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
  nothing that should not run (the Terminal core plugin's shells too: echo,
  ls, pwd in throwaway folders; `SHELL=` or the shell setting picks fish);
  latex-live (the LaTeX core plugin too, which
  reads the copy's `plugins/latex-live/data.json` on its first load: set
  `yoloTabCompletion` and `shellEscape` false there before launching) keeps
  shell escape off and builds in the system temp folder; copies hold the
  vault's `.tex`, `.sty`, `.cls` and `.bst` files (notes' projects `\input`
  sibling projects and `../toolchain`, both inside the vault), and
  stub `dialog.showSaveDialog` in main before Export to HTML, which opens a
  native save dialog CDP cannot see.
