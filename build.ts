import * as esbuild from "esbuild";

const common = {
	bundle: true,
	sourcemap: "linked",
	target: "es2022",
	logLevel: "warning",
} as const;

await Promise.all([
	esbuild.build({
		...common,
		entryPoints: ["src/main/main.ts"],
		outfile: "dist/main.js",
		platform: "node",
		format: "cjs",
		external: ["electron"],
	}),
	// The renderer runs with Node integration, so Node built-ins and electron stay
	// external and resolve through the page's own require at runtime.
	esbuild.build({
		...common,
		entryPoints: ["src/renderer/boot.ts"],
		outfile: "dist/renderer.js",
		platform: "node",
		format: "iife",
		external: ["electron"],
		loader: { ".css": "text" },
	}),
]);

await Bun.write("dist/index.html", Bun.file("src/renderer/index.html"));
// Stylesheets are split per area under src/renderer/styles and concatenated
// in file-name order.
const styles = [...new Bun.Glob("*.css").scanSync("src/renderer/styles")].sort();
const css = await Promise.all(styles.map((name) => Bun.file(`src/renderer/styles/${name}`).text()));
await Bun.write("dist/app.css", css.join("\n"));
await Bun.write("dist/mathjax/tex-svg-full.js", Bun.file("node_modules/mathjax/es5/tex-svg-full.js"));
