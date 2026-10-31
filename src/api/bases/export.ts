// Copying or exporting the rows a view shows, with its visible properties as columns.
import type { BasesViewConfig } from "./config";
import type { QueryController } from "./controller";
import type { BasesEntry } from "./entry";
import type { BasesPropertyId } from "./property";

function cellText(entry: BasesEntry, id: BasesPropertyId) {
	if (id === "file.name") return entry.file.extension === "md" ? entry.file.basename : entry.file.name;
	return entry.getValue(id)?.toString() ?? "";
}

// The rows of a view as text, with its visible properties as columns (the
// file name when it shows none); `justnotes base:query` prints them too.
export function viewTable(config: BasesViewConfig, entries: BasesEntry[]) {
	const order = config.getOrder();
	const columns: BasesPropertyId[] = order.length ? order : ["file.name"];
	return {
		columns,
		header: columns.map((id) => config.getDisplayName(id)),
		rows: entries.map((entry) => columns.map((id) => cellText(entry, id))),
	};
}

function table(controller: QueryController) {
	return viewTable(controller.configs[controller.viewIndex], controller.currentResult.data);
}

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const mdField = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
const htmlField = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The clipboard gets a Markdown table for notes and an HTML table for spreadsheets.
export function exportRows(controller: QueryController, to: "clipboard" | "csv") {
	const { header, rows } = table(controller);
	if (to === "csv") {
		const csv = [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n");
		const name = (controller.source.file?.basename ?? "base").replace(/[\\/:*?"<>|]/g, "-");
		const a = createEl("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), attr: { download: `${name}.csv` } });
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
		return;
	}
	const markdown = [header, header.map(() => "---"), ...rows].map((r) => `| ${r.map(mdField).join(" | ")} |`).join("\n");
	const html = `<table><thead><tr>${header.map((h) => `<th>${htmlField(h)}</th>`).join("")}</tr></thead><tbody>${rows
		.map((r) => `<tr>${r.map((c) => `<td>${htmlField(c)}</td>`).join("")}</tr>`)
		.join("")}</tbody></table>`;
	const item = new ClipboardItem({ "text/plain": new Blob([markdown], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) });
	navigator.clipboard.write([item]).catch(() => navigator.clipboard.writeText(markdown));
}
