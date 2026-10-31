// The frame name the renderer gives window.open for a popout window
// (workspace.ts). Only about:blank under that name opens a window; every other
// window.open is a link and goes through main's link policy.
export const POPOUT_FRAME = "justnotes-popout";

export function isPopoutOpen(url: string, frameName: string) {
	return url === "about:blank" && frameName.startsWith(POPOUT_FRAME);
}
