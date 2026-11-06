// pdf.js's annotation editors listen on the window and the document they
// were loaded in (the vault window): pointer state, text selection (which
// makes highlights) and their shortcuts (undo, delete, select all, arrows).
// A PDF view moved to a popout window gets those from its own window here:
// pointer events and selection changes are replayed in the vault window,
// keys go to the editors' manager, and while they run the vault document's
// getSelection and activeElement answer for the popout's.
export function bridgeToMain(win: Window, scope: HTMLElement, uiManager: () => any, active: () => boolean) {
	if (win === window) return () => {};
	const mainDoc = document as any;
	const within = <T>(fn: () => T): T => {
		Object.defineProperty(mainDoc, "getSelection", { configurable: true, value: () => win.document.getSelection() });
		Object.defineProperty(mainDoc, "activeElement", { configurable: true, get: () => win.document.activeElement });
		try {
			return fn();
		} finally {
			delete mainDoc.getSelection;
			delete mainDoc.activeElement;
		}
	};
	const pointer = (evt: PointerEvent) => {
		const copy = new PointerEvent(evt.type, { button: evt.button, buttons: evt.buttons, clientX: evt.clientX, clientY: evt.clientY, pointerId: evt.pointerId, pointerType: evt.pointerType });
		within(() => window.dispatchEvent(copy));
	};
	const selection = () => within(() => document.dispatchEvent(new Event("selectionchange")));
	const key = (evt: KeyboardEvent) => {
		const ui = uiManager();
		// Only the PDF's keys: another view in the same popout keeps its own.
		// (A popout's nodes are not the vault window's Node: no instanceof.)
		const target = evt.target as Node | null;
		if (!ui || !target || typeof target.nodeType !== "number") return;
		// Keys on the popout's body (nothing focused, as after a selection)
		// belong to the PDF when it is the active tab.
		const loose = target === win.document.body || target === win.document.documentElement;
		if (!scope.contains(target) && !(loose && active())) return;
		const copy = new KeyboardEvent(evt.type, {
			key: evt.key,
			code: evt.code,
			ctrlKey: evt.ctrlKey,
			metaKey: evt.metaKey,
			shiftKey: evt.shiftKey,
			altKey: evt.altKey,
			repeat: evt.repeat,
			cancelable: true,
		});
		// The editors' checks read the event's target: the original's.
		Object.defineProperty(copy, "target", { value: evt.target });
		within(() => (evt.type === "keydown" ? ui.keydown(copy) : ui.keyup(copy)));
		if (copy.defaultPrevented) {
			evt.preventDefault();
			evt.stopPropagation();
		}
	};
	const blur = () => window.dispatchEvent(new Event("blur"));
	win.addEventListener("pointerdown", pointer, true);
	win.addEventListener("pointerup", pointer, true);
	win.document.addEventListener("selectionchange", selection);
	win.addEventListener("keydown", key);
	win.addEventListener("keyup", key);
	win.addEventListener("blur", blur);
	return () => {
		win.removeEventListener("pointerdown", pointer, true);
		win.removeEventListener("pointerup", pointer, true);
		win.document.removeEventListener("selectionchange", selection);
		win.removeEventListener("keydown", key);
		win.removeEventListener("keyup", key);
		win.removeEventListener("blur", blur);
	};
}
