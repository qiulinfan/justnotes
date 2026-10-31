// What main reads from a launch's command line, Electron-free so tests load
// it. `args` are the arguments after the executable (from source the first is
// the checkout, which counts as any other argument).

export const isObsidianUrl = (arg: string) => /^obsidian:/i.test(arg);
export const isMarkdown = (file: string) => /\.(md|markdown)$/i.test(file);

// The arguments `justnotes restart` relaunches with: the launch's own options
// (--profile, Electron and Chromium flags), a --vault for each vault window
// open now, and nothing the launch opened: no --vault of its own, no
// Markdown file and no obsidian: URL, which would open or run again.
export function restartArgs(args: string[], openVaults: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--vault") {
			i++;
		} else if (arg === "--profile") {
			kept.push(...args.slice(i, i + 2));
			i++;
		} else if (!isObsidianUrl(arg) && !isMarkdown(arg)) {
			kept.push(arg);
		}
	}
	return [...kept, ...openVaults.flatMap((vault) => ["--vault", vault])];
}
