import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** The installed console Ghostscript, including TeX Live's native Windows copy. */
export function ghostscript(binDir: string | null): string | null {
  const candidates = process.platform === "win32"
    ? ["gs", "gswin64c", "gswin32c",
      ...(binDir ? [join(binDir, "rungs.exe")] : []), "rungs",
      ...(binDir ? [resolve(binDir, "..", "..", "tlpkg", "tlgs", "bin", "gswin64c.exe")] : [])]
    : ["gs"];
  const broken: string[] = [];
  for (const command of candidates) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    if (result.status !== 0 || !/^\d+\.\d+/m.test(result.stdout)) continue;
    const initialized = spawnSync(command, ["-q", "-dNODISPLAY", "-dBATCH", "-c", "quit"], {
      encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    if (initialized.status === 0) return command;
    broken.push(`${command}: ${initialized.stderr?.trim() || initialized.error?.message || initialized.status}`);
  }
  if (broken.length) throw new Error(`Installed Ghostscript could not initialize: ${broken.join("; ")}`);
  return null;
}
