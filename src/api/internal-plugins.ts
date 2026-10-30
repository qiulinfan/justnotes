// Core plugins Obsidian ships. justnotes implements none of them yet, so each
// reports disabled; plugins that probe them (QuickAdd's templates and daily
// notes) take their fallback path.
export class InternalPlugins {
	plugins: Record<string, { enabled: boolean; instance: any }> = {};

	getPluginById(_id: string) {
		return null;
	}

	getEnabledPluginById(_id: string) {
		return null;
	}
}
