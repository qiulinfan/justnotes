// A namespace import: the tests load this module in Bun, where "electron" is
// only the path of the binary.
import * as electron from "electron";

// A media request the vault page may have: the microphone alone (the Audio
// recorder), asked by the page itself. A <webview> guest, an iframe in the
// page (a plugin's preview server) or a camera request is refused.
export function microphoneRequest(vaultPage: boolean, mainFrame: boolean, mediaTypes: readonly string[] | undefined) {
	return vaultPage && mainFrame && !!mediaTypes?.length && mediaTypes.every((type) => type === "audio");
}

// macOS asks the user once whether the app may use the microphone; until the
// answer Chromium would get silence. A fake capture device (the test
// instances' --use-fake-device-for-media-stream) needs no system access, so
// tests never raise that prompt.
export async function systemMicrophoneAccess() {
	if (process.platform !== "darwin" || electron.app.commandLine.hasSwitch("use-fake-device-for-media-stream")) return true;
	const { systemPreferences } = electron;
	const status = systemPreferences.getMediaAccessStatus("microphone");
	if (status === "granted") return true;
	if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone");
	return false;
}
