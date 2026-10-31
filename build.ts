import * as fs from "node:fs/promises";
import * as esbuild from "esbuild";
import components from "prismjs/components.js";
import getLoader from "prismjs/dependencies.js";

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
	// The justnotes command for the packaged app, which runs it with its own
	// binary as Node (packaging/justnotes, packaging/justnotes.cmd). ESM for the
	// command's top-level await; bundled CommonJS modules get a require.
	esbuild.build({
		...common,
		entryPoints: ["src/cli/justnotes.ts"],
		outfile: "dist/cli/justnotes.mjs",
		platform: "node",
		format: "esm",
		external: ["electron"],
		banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
	}),
]);

await Bun.write("dist/index.html", Bun.file("src/renderer/index.html"));
// Stylesheets are split per area under src/renderer/styles and concatenated
// in file-name order.
const styles = [...new Bun.Glob("*.css").scanSync("src/renderer/styles")].sort();
const css = await Promise.all(styles.map((name) => Bun.file(`src/renderer/styles/${name}`).text()));
await Bun.write("dist/app.css", css.join("\n"));

// The libraries Obsidian exposes (loadMathJax, loadPdfJs, loadPrism,
// loadMermaid) load on first use from dist/lib, which mirrors the app-root
// /lib/ layout plugins address (latex-live fetches /lib/pdfjs/cmaps/ ...).
const lib = "dist/lib";
const mathjax = "node_modules/mathjax/es5";
const pdfjs = "node_modules/pdfjs-dist";
await fs.rm(lib, { recursive: true, force: true });
await Promise.all([
	Bun.write(`${lib}/mathjax/tex-chtml-full.js`, Bun.file(`${mathjax}/tex-chtml-full.js`)),
	Bun.write(`${lib}/mathjax/ui/safe.js`, Bun.file(`${mathjax}/ui/safe.js`)),
	fs.cp(`${mathjax}/output/chtml/fonts/woff-v2`, `${lib}/mathjax/output/chtml/fonts/woff-v2`, { recursive: true }),
	Bun.write(`${lib}/pdfjs/pdf.min.mjs`, Bun.file(`${pdfjs}/build/pdf.min.mjs`)),
	Bun.write(`${lib}/pdfjs/pdf.worker.min.mjs`, Bun.file(`${pdfjs}/build/pdf.worker.min.mjs`)),
	...["cmaps", "standard_fonts", "wasm", "iccs"].map((dir) => fs.cp(`${pdfjs}/${dir}`, `${lib}/pdfjs/${dir}`, { recursive: true })),
	Bun.write(`${lib}/mermaid/mermaid.min.js`, Bun.file("node_modules/mermaid/dist/mermaid.min.js")),
	Bun.write(`${lib}/prism/prism.js`, await prismBundle()),
]);

// Prism core plus every language, in dependency order, as one script. The
// wrapper hides the page's CommonJS `module` and `global` (Node integration
// defines both) so Prism registers only window.Prism, and `manual` keeps it
// from highlighting the page on its own.
async function prismBundle() {
	const ids = getLoader(components, Object.keys(components.languages).filter((id) => id !== "meta")).getIds();
	const parts = await Promise.all(
		["core", ...ids].map((id) => Bun.file(`node_modules/prismjs/components/prism-${id}.min.js`).text()),
	);
	return `window.Prism = Object.assign(window.Prism || {}, { manual: true, disableWorkerMessageHandler: true });
(function (module, global) {
${parts.join(";\n")}
})();
`;
}
