// App commands that keep working while a terminal has the keyboard, as the
// terminal plugin lets its own commands through: window-level commands
// (palette, switcher, settings, tabs, splits, sidebars) and the terminal's.
// Every other key goes to the shell, except, on macOS, any Cmd shortcut,
// which a shell never receives anyway.
const WINDOW_COMMANDS = new Set([
	"command-palette:open",
	"switcher:open",
	"app:open-settings",
	"app:toggle-left-sidebar",
	"app:toggle-right-sidebar",
	"app:go-back",
	"app:go-forward",
	"workspace:new-tab",
	"workspace:close",
	"workspace:undo-close-pane",
	"workspace:next-tab",
	"workspace:previous-tab",
	"workspace:goto-last-tab",
	"workspace:split-vertical",
	"workspace:split-horizontal",
	...Array.from({ length: 8 }, (_, i) => `workspace:goto-tab-${i + 1}`),
]);

export type KeyAction = "copy" | "paste" | "clear" | "find" | "select-all" | { send: string };

// Keys the terminal itself answers before the shell or the app sees them.
// On macOS: Cmd+C/V/K/F/A, and Ghostty's default line-editing keys (Cmd and
// Option with the arrows, Cmd+Backspace, Option+Delete). Elsewhere the
// Ctrl+Shift forms, which leave Ctrl+C and Ctrl+V to the shell, except that
// Ctrl+C copies while text is selected.
export function terminalKeyAction(evt: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac: boolean, hasSelection: boolean): KeyAction | null {
	const key = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key;
	const letter = /^Key[A-Z]$/.test(evt.code) ? evt.code.slice(3).toLowerCase() : key;
	if (mac) {
		const cmd = evt.metaKey && !evt.ctrlKey && !evt.altKey;
		if (cmd && !evt.shiftKey) {
			if (letter === "c") return hasSelection ? "copy" : null;
			if (letter === "v") return "paste";
			if (letter === "k") return "clear";
			if (letter === "f") return "find";
			if (letter === "a") return "select-all";
			if (key === "ArrowLeft") return { send: "\x01" };
			if (key === "ArrowRight") return { send: "\x05" };
			if (key === "Backspace") return { send: "\x15" };
		}
		if (evt.altKey && !evt.metaKey && !evt.ctrlKey && !evt.shiftKey) {
			if (key === "ArrowLeft") return { send: "\x1bb" };
			if (key === "ArrowRight") return { send: "\x1bf" };
			if (key === "Delete") return { send: "\x1bd" };
		}
		return null;
	}
	if (evt.ctrlKey && !evt.metaKey && !evt.altKey) {
		if (evt.shiftKey) {
			if (letter === "c") return "copy";
			if (letter === "v") return "paste";
			if (letter === "k") return "clear";
			if (letter === "f") return "find";
			if (letter === "a") return "select-all";
		} else if (letter === "c" && hasSelection) return "copy";
	}
	return null;
}

// Whether a hotkey of the app command `id` runs while a terminal has focus.
export function appCommandAllowed(id: string, evt: Pick<KeyboardEvent, "metaKey">, mac: boolean) {
	return (mac && evt.metaKey) || WINDOW_COMMANDS.has(id) || id.startsWith("terminal:");
}
