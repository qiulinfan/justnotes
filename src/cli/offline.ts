import type { App } from "../api/app";
import { installLanguageExtensions } from "../api/dom";
import { InternalPlugins } from "../api/internal-plugins";
import { MetadataCache } from "../api/metadata";
import { MetadataTypeManager } from "../api/metadata-types";
import { Vault } from "../api/vault";
import type { Ctx } from "./commands/context";
import { VAULT_COMMANDS } from "./commands/vault";
import type { CliResponse } from "./protocol";
import { runBuiltin } from "./run";
import type { CommandSpec } from "./spec";

// Runs a read-only built-in command with no app running: the command loads
// the vault itself with the app's own Vault, MetadataCache, property types and
// core plugin options, and reads; it writes nothing. A command that needs the
// running app (the active file, a change) throws NeedsApp to the caller.
export async function runOffline(spec: CommandSpec, vaultPath: string, words: string[], cwd: string, version: string): Promise<CliResponse> {
	const handler = VAULT_COMMANDS[spec.name];
	if (!handler) throw new Error(`${spec.name} needs the app`);
	// The app's modules rely on Obsidian's Array and String additions.
	installLanguageExtensions();
	// The yaml library warns on stderr about odd frontmatter (a template's
	// `{{date}}`); the app does not show those either.
	process.emitWarning = () => {};
	const vault = new Vault(vaultPath);
	const app = { vault, loadLocalStorage: () => null, saveLocalStorage() {} } as unknown as App;
	try {
		await vault.load();
		app.metadataCache = new MetadataCache(vault);
		await app.metadataCache.initialize();
		app.metadataTypeManager = new MetadataTypeManager(app);
		await app.metadataTypeManager.load();
		app.internalPlugins = new InternalPlugins(app);
		await app.internalPlugins.initialize();
		const ctx: Ctx = { app, live: false, version, cwd };
		return await runBuiltin(spec, handler, ctx, words);
	} finally {
		app.metadataTypeManager?.unload();
		vault.close();
	}
}
