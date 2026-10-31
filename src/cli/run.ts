import { parseCliArgs } from "./args";
import type { Ctx, Handler } from "./commands/context";
import { CliError, NeedsApp, render } from "./output";
import { type CliResponse, EXIT_FAILURE, EXIT_USAGE } from "./protocol";
import { type CommandSpec, flagsOf } from "./spec";

// Runs one built-in command: parses its flags, calls its handler and prints
// the result (JSON for --json or format=json). A NeedsApp from a headless run
// goes to the caller, which asks the app instead.
export async function runBuiltin(spec: CommandSpec, handler: Handler, ctx: Ctx, words: string[]): Promise<CliResponse> {
	const parsed = parseCliArgs(words, flagsOf(spec));
	if ("error" in parsed) return { stdout: "", stderr: `${parsed.error}\nRun "justnotes help ${spec.name}" for its flags.`, code: EXIT_USAGE };
	try {
		const out = await handler(ctx, parsed.params);
		return { stdout: render(out, parsed.params), stderr: "", code: 0 };
	} catch (err) {
		if (err instanceof NeedsApp) throw err;
		if (err instanceof CliError) return { stdout: "", stderr: err.message, code: err.code };
		if (ctx.live) console.error(`CLI command ${spec.name} failed`, err);
		return { stdout: "", stderr: err instanceof Error ? err.message : String(err), code: EXIT_FAILURE };
	}
}
