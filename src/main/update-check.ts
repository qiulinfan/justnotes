// What the updater (updater.ts) decides from GitHub's latest release,
// Electron-free so tests load it. CI publishes every push to main as the
// latest release, tagged main-<version>-<commit7> on the built commit.

export interface BuildInfo {
	// The full commit the app was built from; "" when unknown.
	commit: string;
	// When it was built, in ms.
	time: number;
}

export interface ReleaseAsset {
	name: string;
	url: string;
	size: number;
}

export interface LatestRelease {
	tag: string;
	commit: string | null;
	publishedAt: number;
	asset: ReleaseAsset | null;
}

interface GithubRelease {
	tag_name?: unknown;
	published_at?: unknown;
	assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown }[];
}

// The commit a main-<version>-<commit> tag was made on.
export function releaseCommit(tag: string): string | null {
	return /^main-.+-([0-9a-f]{7,40})$/.exec(tag)?.[1] ?? null;
}

// The zip electron-builder makes for this platform and architecture
// (artifactName in electron-builder.yml): the app bundle on macOS, the app
// folder's contents on Windows.
export function assetName(platform: string, arch: string): RegExp | null {
	if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return new RegExp(`-mac-${arch}\\.zip$`);
	if (platform === "win32" && arch === "x64") return /-win-x64\.zip$/;
	return null;
}

export function parseRelease(json: GithubRelease, platform: string, arch: string): LatestRelease | null {
	if (typeof json.tag_name !== "string") return null;
	const pattern = assetName(platform, arch);
	const found = pattern && json.assets?.find((a) => typeof a.name === "string" && pattern.test(a.name));
	const asset = found && typeof found.browser_download_url === "string" ? { name: String(found.name), url: found.browser_download_url, size: Number(found.size) || 0 } : null;
	const publishedAt = typeof json.published_at === "string" ? Date.parse(json.published_at) : Number.NaN;
	return { tag: json.tag_name, commit: releaseCommit(json.tag_name), publishedAt, asset };
}

// A release is an update when it was built from another commit and published
// after this app was built: a release of the same commit (installed from it,
// or built from the same checkout) is this app, and one from before the build
// is older than a local build of a commit not pushed yet.
export function isUpdate(build: BuildInfo, release: LatestRelease) {
	if (!release.commit || !release.asset || !Number.isFinite(release.publishedAt)) return false;
	if (build.commit && build.commit.startsWith(release.commit)) return false;
	return release.publishedAt > build.time;
}

// Single quotes for a POSIX shell word, and for a PowerShell string literal.
export const shellWord = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
export const psWord = (s: string) => `'${s.replace(/'/g, "''")}'`;

// The script that swaps the staged app in once this process has exited, as
// scripts/install.ts swaps an install: copied beside the installed bundle,
// then renamed in, so a failure leaves the installed app as it was; Launch
// Services then learns the new bundle. `relaunch` is the arguments to open
// it again with, or null to leave it closed.
export function macSwapScript(pid: number, staged: string, bundle: string, relaunch: string[] | null) {
	const dir = bundle.slice(0, bundle.lastIndexOf("/"));
	const name = bundle.slice(bundle.lastIndexOf("/") + 1);
	const next = `${dir}/.${name}.new`;
	const old = `${dir}/.${name}.old`;
	const open = relaunch === null ? "" : `open ${shellWord(bundle)}${relaunch.length ? ` --args ${relaunch.map(shellWord).join(" ")}` : ""}\n`;
	return `#!/bin/sh
while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done
rm -rf ${shellWord(next)} ${shellWord(old)}
ditto ${shellWord(staged)} ${shellWord(next)} || exit 1
if mv ${shellWord(bundle)} ${shellWord(old)}; then
	mv ${shellWord(next)} ${shellWord(bundle)} || { mv ${shellWord(old)} ${shellWord(bundle)}; exit 1; }
else
	rm -rf ${shellWord(next)}; exit 1
fi
rm -rf ${shellWord(old)} ${shellWord(staged)}
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ${shellWord(bundle)}
${open}`;
}

// The same on Windows: the install folder becomes <folder>.previous (as
// scripts/install.ts keeps the last install) and the staged folder takes its
// place; renames are retried while Windows still holds the exiting app's
// files. An NSIS install's uninstaller is carried over.
export function windowsSwapScript(pid: number, staged: string, dir: string, relaunch: string[] | null) {
	const previous = `${dir}.previous`;
	const exe = `${dir}\\justnotes.exe`;
	const start = relaunch === null ? "" : `Start-Process -FilePath ${psWord(exe)}${relaunch.length ? ` -ArgumentList @(${relaunch.map((a) => psWord(a.includes(" ") ? `"${a}"` : a)).join(", ")})` : ""}\r\n`;
	return `$ErrorActionPreference = 'Stop'\r
Wait-Process -Id ${pid} -ErrorAction SilentlyContinue\r
function Retry($action) { for ($i = 0; $i -lt 50; $i++) { try { & $action; return } catch { Start-Sleep -Milliseconds 200 } }; & $action }\r
if (Test-Path ${psWord(previous)}) { Remove-Item -Recurse -Force ${psWord(previous)} }\r
Retry { Rename-Item -LiteralPath ${psWord(dir)} -NewName ${psWord(previous.slice(previous.lastIndexOf("\\") + 1))} }\r
try { Retry { Move-Item -LiteralPath ${psWord(staged)} -Destination ${psWord(dir)} } } catch { Rename-Item -LiteralPath ${psWord(previous)} -NewName ${psWord(dir.slice(dir.lastIndexOf("\\") + 1))}; exit 1 }\r
Get-ChildItem -LiteralPath ${psWord(previous)} -Filter 'Uninstall *.exe' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination ${psWord(dir)} }\r
${start}`;
}
