# justnotes development

justnotes is an Electron app that hosts Obsidian community plugins. It
reimplements the `obsidian` module from scratch; never copy or unpack code from
Obsidian's `app.asar`.

## Layout

- `src/main/main.ts`: Electron main process. Opens one window per vault with
  Node integration on, because plugins `require("fs")`, `child_process` and
  `electron` directly.
- `src/api/`: the `obsidian` module. `index.ts` is the export list plugins see.
  `dom.ts` installs Obsidian's prototype and global augmentations (`createEl`,
  `addClass`, `Array.prototype.remove`, ...) and must run before any plugin code.
- `src/api/plugins.ts`: loads `.obsidian/plugins/<id>/main.js` with a `require`
  that returns this `obsidian` module and the host's own CodeMirror and Lezer
  modules. Plugins must share the editor's CodeMirror instances; never let them
  resolve their own copies.
- `src/renderer/`: host UI (boot, file explorer, command palette, quick
  switcher) and `app.css`, which keeps Obsidian's CSS variable and class names so
  plugin stylesheets apply.

## Compatibility rules

- The reference for signatures is `node_modules/obsidian/obsidian.d.ts`. Plugins
  also use private API (`app.scope`, `app.hotkeyManager.bake()`,
  `bakedHotkeys`, `app.commands.findCommand`, `EditorSuggest.suggestions`);
  read the plugin's bundled `main.js` to see exactly what it touches and match
  that behavior rather than guessing.
- Keyboard handling follows Obsidian: a capture-phase `keydown` listener walks
  the keymap scope stack before CodeMirror sees the key. The root scope's
  catch-all handler runs command hotkeys; plugins may replace it.
- Never write Obsidian's own config files (`workspace.json`,
  `community-plugins.json`, `app.json`, `hotkeys.json`). justnotes state lives in
  localStorage via `app.saveLocalStorage`.

## Verify

- `bun run check` (TypeScript) and `bun run build`.
- Test against a copy of a vault, never the user's real vaults: plugins write
  their `data.json`, and some (obsidian-git, kgdistiller, terminal) run external
  programs. Trim the copy's `community-plugins.json` to the plugins under test.
- Launch with `--remote-debugging-port=<port>` and drive the renderer over the
  Chrome DevTools Protocol: `Runtime.evaluate` for state (`window.app` is the
  App), `Input.dispatchKeyEvent` for real key presses (plugins read keydown),
  `Page.captureScreenshot` to look at it.
