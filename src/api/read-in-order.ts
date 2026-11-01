import type { TFile, Vault } from "./vault";

// The notes' texts through cachedRead, in the order given, with up to `ahead`
// reads under way: a scan of the vault (search, unlinked mentions) does not
// wait for one read at a time. A failed read throws where its file comes up,
// as an awaited read in a loop would; a consumer that stops early leaves at
// most `ahead` reads unused.
export async function* readInOrder(vault: Vault, files: TFile[], ahead = 16): AsyncGenerator<[TFile, string]> {
	const reads: Promise<string>[] = [];
	const start = (i: number) => {
		const read = vault.cachedRead(files[i]);
		// Handled here, rethrown when awaited: a read that fails before its
		// turn is no unhandled rejection.
		read.catch(() => {});
		reads[i] = read;
	};
	for (let i = 0; i < Math.min(ahead, files.length); i++) start(i);
	for (let i = 0; i < files.length; i++) {
		const text = await reads[i];
		delete reads[i];
		if (i + ahead < files.length) start(i + ahead);
		yield [files[i], text];
	}
}
