import type { App } from "../api/app";
import { importFile } from "../api/attachments";
import type { CorePluginHost } from "../api/internal-plugins";
import { MarkdownView } from "../api/markdown-view";
import { Notice } from "../api/ui/notice";
import { moment } from "../api/util";

export interface RecordingFormat {
	mimeType: string;
	extension: string;
}

// What MediaRecorder writes, in order of preference: Obsidian's desktop
// recordings are WebM (Opus), which Electron's Chromium records; MP4 and Ogg
// are there for a runtime without WebM.
const FORMATS: RecordingFormat[] = [
	{ mimeType: "audio/webm", extension: "webm" },
	{ mimeType: "audio/mp4", extension: "m4a" },
	{ mimeType: "audio/ogg", extension: "ogg" },
];

export function recordingFormat(isTypeSupported: (mimeType: string) => boolean) {
	return FORMATS.find((format) => isTypeSupported(format.mimeType)) ?? null;
}

// "Recording 20261031143005.webm", named like a pasted image.
export function recordingName(extension: string, time: Date) {
	return `Recording ${moment(time).format("YYYYMMDDHHmmss")}.${extension}`;
}

interface Session {
	recorder: MediaRecorder;
	stream: MediaStream;
	chunks: Blob[];
	format: RecordingFormat;
	stopped: Promise<void>;
}

function startError(err: unknown) {
	const name = err instanceof DOMException ? err.name : "";
	if (name === "NotAllowedError") return "Could not start recording: microphone access was denied. Allow it in the system's privacy settings.";
	if (name === "NotFoundError") return "Could not start recording: no microphone found.";
	return `Could not start recording: ${err instanceof Error ? err.message : err}`;
}

// The embed inserted at the cursor, on a line of its own: a player in the
// middle of a line of text would sit beside it.
export function embedText(link: string, before: string, after: string) {
	return `${before.trim() ? "\n" : ""}${link}${after.trim() ? "\n" : ""}`;
}

// The recording goes into the attachment folder for the active note and is
// embedded at its cursor; with no note open it opens in a tab of its own.
async function saveRecording(app: App, blob: Blob, format: RecordingFormat) {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	const note = view?.file ?? null;
	const sourcePath = note?.path ?? "";
	const file = await importFile(app, new File([blob], recordingName(format.extension, new Date()), { type: blob.type }), sourcePath);
	if (view && note && view.file === note) {
		const editor = view.editor;
		const at = editor.getCursor();
		const line = editor.getLine(at.line);
		const link = embedText(app.fileManager.generateMarkdownLink(file, sourcePath), line.slice(0, at.ch), line.slice(at.ch));
		editor.replaceRange(link, at);
		editor.setCursor(editor.offsetToPos(editor.posToOffset(at) + link.length));
	} else {
		await app.workspace.getLeaf(false).openFile(file);
	}
}

// Obsidian's Audio recorder: the ribbon button starts and stops a recording
// of the microphone and turns red while it records; the commands do the
// same. Turning the plugin off ends a recording and saves it.
export function installAudioRecorder(app: App, host: CorePluginHost) {
	let session: Session | null = null;
	let starting = false;
	let unloaded = false;

	const button = host.addRibbonIcon("audio-recorder:Start/stop recording", "mic", "Start/stop recording", () => void (session ? stop() : start()));
	const show = () => button.toggleClass("is-recording", !!session);

	async function start() {
		if (session || starting) return;
		const format = recordingFormat((mimeType) => MediaRecorder.isTypeSupported(mimeType));
		if (!format) {
			new Notice("Could not start recording: audio recording is not supported.");
			return;
		}
		starting = true;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			new Notice(startError(err));
			return;
		} finally {
			starting = false;
		}
		if (unloaded) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		const recorder = new MediaRecorder(stream, { mimeType: format.mimeType });
		const chunks: Blob[] = [];
		const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
		recorder.addEventListener("dataavailable", (evt) => {
			if (evt.data.size) chunks.push(evt.data);
		});
		recorder.start();
		session = { recorder, stream, chunks, format, stopped };
		show();
	}

	async function stop() {
		const current = session;
		if (!current) return;
		session = null;
		show();
		current.recorder.stop();
		await current.stopped;
		for (const track of current.stream.getTracks()) track.stop();
		const blob = new Blob(current.chunks, { type: current.recorder.mimeType || current.format.mimeType });
		try {
			await saveRecording(app, blob, current.format);
		} catch (err) {
			console.error(err);
			new Notice(`Could not save the recording: ${err instanceof Error ? err.message : err}`);
		}
	}

	host.addCommand({
		id: "audio-recorder:start",
		name: "Audio recorder: Start recording audio",
		checkCallback: (checking) => {
			if (session || starting) return false;
			if (!checking) void start();
			return true;
		},
	});
	host.addCommand({
		id: "audio-recorder:stop",
		name: "Audio recorder: Stop recording audio",
		checkCallback: (checking) => {
			if (!session) return false;
			if (!checking) void stop();
			return true;
		},
	});
	host.register(() => {
		unloaded = true;
		void stop();
	});
}
