import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { psWord, windowsSwapScript } from "../src/main/update-check";

function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes 更新 ' ")));
	const installed = path.join(root, "installed app");
	const staged = path.join(root, "downloaded app");
	for (const [folder, value] of [
		[installed, "old"],
		[staged, "new"],
	]) {
		fs.mkdirSync(path.join(folder, "resources"), { recursive: true });
		fs.writeFileSync(path.join(folder, "justnotes.exe"), value);
		fs.writeFileSync(path.join(folder, "resources", "app.asar"), value);
	}
	fs.writeFileSync(path.join(installed, "Uninstall justnotes.exe"), "keep");
	fs.mkdirSync(path.join(root, "profile"));
	fs.writeFileSync(path.join(root, "profile", "vaults.json"), "keep");
	return { root, installed, staged };
}

function run(script: string, root: string, cwd: string) {
	const file = path.join(root, "update.ps1");
	// Windows PowerShell 5.1 otherwise reads non-ASCII paths as the system codepage.
	fs.writeFileSync(file, "\uFEFF" + script);
	return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
}

test.skipIf(process.platform !== "win32")("Windows updates in place, preserving the app directory, uninstaller and profile", () => {
	const { root, installed, staged } = fixture();
	try {
		const before = fs.statSync(installed, { bigint: true });
		const result = run(windowsSwapScript(0, staged, installed, null), root, installed);
		expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
		expect(fs.statSync(installed, { bigint: true }).ino).toBe(before.ino);
		expect(fs.readFileSync(path.join(installed, "justnotes.exe"), "utf8")).toBe("new");
		expect(fs.readFileSync(path.join(installed, "resources", "app.asar"), "utf8")).toBe("new");
		expect(fs.readFileSync(path.join(installed + ".previous", "justnotes.exe"), "utf8")).toBe("old");
		expect(fs.readFileSync(path.join(installed, "Uninstall justnotes.exe"), "utf8")).toBe("keep");
		expect(fs.readFileSync(path.join(root, "profile", "vaults.json"), "utf8")).toBe("keep");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")("Windows relaunch preserves vault and profile arguments, including trailing backslashes", async () => {
	const { root, installed, staged } = fixture();
	try {
		fs.unlinkSync(path.join(staged, "justnotes.exe"));
		const resultFile = path.join(root, "arguments.txt");
		const pidFile = resultFile + ".pid";
		const code = `public class Entry { public static void Main(string[] args) {
System.IO.File.WriteAllLines(${JSON.stringify(resultFile)}, args);
System.IO.File.WriteAllText(${JSON.stringify(pidFile + ".tmp")}, System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
System.IO.File.Move(${JSON.stringify(pidFile + ".tmp")}, ${JSON.stringify(pidFile)});
} }`;
		const compile = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Add-Type -TypeDefinition ${psWord(code)} -OutputAssembly ${psWord(path.join(staged, "justnotes.exe"))} -OutputType WindowsApplication`;
		const compiler = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(compile, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
		expect({ status: compiler.status, error: compiler.stderr }).toEqual({ status: 0, error: "" });
		const args = ["--vault", "C:\\My Notes\\", "--profile", "C:\\profile's folder"];
		const result = run(windowsSwapScript(0, staged, installed, args), root, root);
		expect(result.status).toBe(0);
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(pidFile)) {
			if (Date.now() > deadline) throw new Error("Updated application did not relaunch");
			await Bun.sleep(20);
		}
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		expect(Number.isInteger(pid) && pid > 0).toBe(true);
		const exited = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`], { timeout: 10_000, windowsHide: true });
		if (exited.error) throw exited.error;
		expect(
			fs
				.readFileSync(resultFile, "utf8")
				.replace(/^\uFEFF/, "")
				.trimEnd()
				.split(/\r?\n/),
		).toEqual(args);
	} finally {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test.skipIf(process.platform !== "win32")("Windows refuses a payload inside the previous-install directory without deleting it", () => {
	const { root, installed } = fixture();
	const staged = path.join(installed + ".previous", "payload");
	try {
		fs.mkdirSync(staged, { recursive: true });
		fs.writeFileSync(path.join(staged, "justnotes.exe"), "keep");
		const result = run(windowsSwapScript(0, staged, installed, null), root, root);
		expect(result.status).not.toBe(0);
		expect(fs.readFileSync(path.join(staged, "justnotes.exe"), "utf8")).toBe("keep");
		expect(fs.readFileSync(path.join(installed, "justnotes.exe"), "utf8")).toBe("old");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")(
	"Windows rolls back when moving the second payload entry fails",
	() => {
		const { root, installed, staged } = fixture();
		try {
			const fault = `function Move-Item { param($LiteralPath, $Destination)
if ((Split-Path -Leaf $LiteralPath) -eq 'resources' -and (Get-Content -LiteralPath (Join-Path $LiteralPath 'app.asar') -Raw) -eq 'new') { throw [IO.IOException]::new('test move failure') }
Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}\n`;
			const result = run(fault + windowsSwapScript(0, staged, installed, null), root, root);
			expect(result.status).not.toBe(0);
			expect(fs.readFileSync(path.join(installed, "justnotes.exe"), "utf8")).toBe("old");
			expect(fs.readFileSync(path.join(installed, "resources", "app.asar"), "utf8")).toBe("old");
			expect(fs.readFileSync(path.join(staged, "justnotes.exe"), "utf8")).toBe("new");
			expect(fs.readFileSync(path.join(root, "profile", "vaults.json"), "utf8")).toBe("keep");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);

test.skipIf(process.platform !== "win32")("Windows rejects incomplete payloads before changing the installed app", () => {
	const { root, installed, staged } = fixture();
	try {
		fs.unlinkSync(path.join(staged, "justnotes.exe"));
		const result = run(windowsSwapScript(0, staged, installed, null), root, root);
		expect(result.status).not.toBe(0);
		expect(fs.readFileSync(path.join(installed, "justnotes.exe"), "utf8")).toBe("old");
		expect(fs.existsSync(installed + ".previous")).toBe(false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
