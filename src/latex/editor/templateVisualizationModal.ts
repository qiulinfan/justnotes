import { App, Modal } from "obsidian";
import { parseTemplateProfiles, type EnvironmentVisualization, type TemplateVisualizationProfile } from "./templateVisualization";

export interface TemplateVisualizationHost {
  app: App;
  profiles: readonly TemplateVisualizationProfile[];
  selected: string;
  project: string | null;
  save(profiles: TemplateVisualizationProfile[], selected: string): Promise<void>;
  closed?(): void;
}

/** A local draft: cancel/import/typing never change the running editor or persisted settings. */
export class TemplateVisualizationModal extends Modal {
  private profiles: TemplateVisualizationProfile[];
  private selected: string;
  private picker!: HTMLSelectElement;
  private form!: HTMLElement;
  private error!: HTMLElement;
  private composing = false;
  private closed = false;

  constructor(private host: TemplateVisualizationHost) {
    super(host.app);
    this.profiles = parseTemplateProfiles(host.profiles);
    this.selected = this.profiles.some(p => p.id === host.selected) ? host.selected : "auto";
  }

  onOpen(): void {
    this.closed = false;
    this.titleEl.setText("Template visualization");
    this.modalEl.addClass("ll-template-modal");
    this.contentEl.createEl("p", { text: this.host.project ? `Project: ${this.host.project}` : "Open a .tex project to select its visualization. Profiles can still be saved here." });
    this.contentEl.createEl("p", { text: "Customize theorem-like environments in live preview. PDF, reference names and TeX source keep their original template. Unspecified rules keep automatic visualization. Profiles are shared in this vault; editing a profile updates every project using it." });
    const bar = this.contentEl.createDiv({ cls: "ll-template-actions" });
    this.picker = bar.createEl("select", { attr: { "aria-label": "Visualization profile" } });
    this.fillPicker();
    this.picker.addEventListener("change", () => { this.selected = this.picker.value; this.drawProfile(); });
    this.button(bar, "New profile", () => {
      if (this.profiles.length >= 30) { this.error.setText("Use at most 30 profiles."); return; }
      let n = 1; while (this.profiles.some(p => p.name === `Custom template ${n}`)) n++;
      const p: TemplateVisualizationProfile = { id: this.newId(), name: `Custom template ${n}`, environments: [
        { environment: "definition", color: "#00a652" },
        { environment: "theorem", color: "#ff8618" },
        { environment: "proof", color: "#ff8618" },
      ] };
      this.profiles.push(p); this.selected = p.id; this.fillPicker(); this.drawProfile();
    });
    this.button(bar, "Delete selected profile", () => {
      this.profiles = this.profiles.filter(p => p.id !== this.selected);
      this.selected = "auto"; this.fillPicker(); this.drawProfile();
    });
    this.form = this.contentEl.createDiv({ cls: "ll-template-form" });
    this.error = this.contentEl.createDiv({ cls: "ll-template-error", attr: { role: "status", "aria-live": "polite" } });
    const actions = this.contentEl.createDiv({ cls: "ll-template-actions" });
    const save = this.button(actions, this.host.project ? "Save and use selected profile" : "Save profiles", () => {
      if (this.composing) { this.error.setText("Finish composing text before saving."); return; }
      let valid: TemplateVisualizationProfile[];
      try { valid = parseTemplateProfiles(this.profiles); }
      catch (error) { this.error.setText(error instanceof Error ? error.message : String(error)); return; }
      save.disabled = true;
      void this.host.save(valid, this.selected).then(() => { if (!this.closed) this.close(); }).catch(error => {
        if (!this.closed) { this.error.setText(error instanceof Error ? error.message : String(error)); save.disabled = false; }
      });
    });
    save.addClass("mod-cta");
    this.button(actions, "Cancel", () => this.close());
    this.contentEl.addEventListener("compositionstart", () => { this.composing = true; });
    this.contentEl.addEventListener("compositionend", () => { this.composing = false; });
    this.drawProfile();
  }

  onClose(): void { this.closed = true; this.host.closed?.(); this.contentEl.empty(); }

  private newId(): string { return `template-${globalThis.crypto.randomUUID()}`; }

  private fillPicker(): void {
    this.picker.empty();
    this.picker.createEl("option", { text: "Automatic (original template)", value: "auto" });
    for (const p of this.profiles) this.picker.createEl("option", { text: p.name, value: p.id });
    this.picker.value = this.selected;
  }

  private button(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { text, attr: { type: "button" } });
    b.addEventListener("click", run);
    return b;
  }

  private text(parent: HTMLElement, label: string, value: string, change: (value: string) => void, placeholder = ""): HTMLInputElement {
    const row = parent.createEl("label", { cls: "ll-template-field" }); row.createSpan({ text: label });
    const input = row.createEl("input", { attr: { type: "text", "aria-label": label, placeholder } });
    input.value = value;
    input.addEventListener("input", () => change(input.value));
    return input;
  }

  private select(parent: HTMLElement, label: string, choices: Record<string, string>, value: string, change: (value: string) => void): void {
    const row = parent.createEl("label", { cls: "ll-template-field" }); row.createSpan({ text: label });
    const input = row.createEl("select", { attr: { "aria-label": label } });
    for (const [key, text] of Object.entries(choices)) input.createEl("option", { text, value: key });
    input.value = value; input.addEventListener("change", () => change(input.value));
  }

  private drawProfile(): void {
    this.form.empty(); this.error?.setText("");
    const p = this.profiles.find(p => p.id === this.selected);
    if (!p) { this.form.createEl("p", { text: "Automatic visualization uses the environments and colors detected from the original LaTeX template." }); return; }
    this.text(this.form, "Profile name", p.name, value => {
      p.name = value;
      const option = [...this.picker.options].find(o => o.value === p.id);
      if (option) option.textContent = value || "Unnamed profile";
    });
    this.form.createEl("p", { text: "Environment names omit \\begin and braces. Blank fields and Auto preserve detected behavior. Colors use #RRGGBB. Unknown environments need their title-argument form configured; numbering uses compiled labels." });
    const rules = this.form.createDiv({ cls: "ll-template-rules" });
    for (const rule of p.environments) this.drawRule(rules, p, rule);
    this.button(this.form, "Add environment", () => {
      if (p.environments.length >= 100) { this.error.setText("Use at most 100 rules per profile."); return; }
      const rule: EnvironmentVisualization = { environment: "" };
      p.environments.push(rule); this.drawRule(rules, p, rule, true);
    });
    const json = this.form.createEl("details", { cls: "ll-template-json" });
    json.createEl("summary", { text: "Import / export profile JSON" });
    const area = json.createEl("textarea", { attr: { "aria-label": "Profile JSON", rows: "8", spellcheck: "false", maxlength: "200000" } });
    area.value = JSON.stringify(p, null, 2);
    this.button(json, "Update JSON from fields", () => { area.value = JSON.stringify(p, null, 2); });
    this.button(json, "Import as a new profile", () => {
      try {
        if (area.value.length > 200000) throw new Error("A profile JSON document may contain at most 200,000 characters.");
        const imported = parseTemplateProfiles([JSON.parse(area.value)])[0];
        if (this.profiles.length >= 30) throw new Error("Use at most 30 profiles.");
        imported.id = this.newId(); this.profiles.push(imported); this.selected = imported.id;
        this.fillPicker(); this.drawProfile();
      } catch (error) { this.error.setText(error instanceof Error ? error.message : String(error)); }
    });
  }

  private drawRule(parent: HTMLElement, profile: TemplateVisualizationProfile, r: EnvironmentVisualization, open = false): void {
    const card = parent.createEl("details", { cls: "ll-template-rule" }); card.open = open;
    const summary = card.createEl("summary", { text: r.environment || "New environment" });
    this.text(card, "Environment", r.environment, value => { r.environment = value.trim(); summary.setText(r.environment || "New environment"); });
    this.select(card, "Rendering", { box: "Theorem-like box", source: "Show environment markup" }, r.render ?? "box", value => { r.render = value as "box" | "source"; });
    this.text(card, "Heading", r.name ?? "", value => { if (value) r.name = value; else delete r.name; }, "Auto");
    const color = this.text(card, "Color (#RRGGBB)", r.color ?? "", value => {
      if (value.trim()) r.color = value.trim(); else delete r.color;
      if (/^#[0-9a-fA-F]{6}$/.test(value.trim())) picker.value = value.trim();
    }, "Auto, e.g. #00a652");
    const controls = color.parentElement!.createDiv({ cls: "ll-template-color-control" }); controls.appendChild(color);
    const picker = controls.createEl("input", { attr: { type: "color", "aria-label": "Pick a custom color" } });
    picker.value = /^#[0-9a-fA-F]{6}$/.test(r.color ?? "") ? r.color! : "#000000";
    picker.addEventListener("input", () => { r.color = picker.value; color.value = picker.value; });
    this.select(card, "Title arguments", { auto: "Auto (from source)", "": "No title argument", o: "Optional [title]", m: "Required {title}", tcb: "{title}{label} (optional title; label prefix below)", "tcb*": "Optional {title} or [title], no label argument" }, r.arguments ?? "auto", value => { if (value === "auto") delete r.arguments; else r.arguments = value as EnvironmentVisualization["arguments"]; });
    this.select(card, "Title position", { auto: "Auto", paren: "After heading, in parentheses", after: "After heading", replace: "Replace heading", name: "Use title as heading" }, r.titlePosition ?? "auto", value => { if (value === "auto") delete r.titlePosition; else r.titlePosition = value as EnvironmentVisualization["titlePosition"]; });
    this.select(card, "Numbered", { auto: "Auto", yes: "Use compiled label number", no: "No number" }, r.numbered === undefined ? "auto" : r.numbered ? "yes" : "no", value => { if (value === "auto") delete r.numbered; else r.numbered = value === "yes"; });
    this.text(card, "Label prefix", r.labelPrefix ?? "", value => { if (value.trim()) r.labelPrefix = value.trim(); else delete r.labelPrefix; }, "Auto; e.g. thm for thm:label");
    let mark: HTMLInputElement;
    this.select(card, "End mark mode", { auto: "Auto", none: "No end mark", custom: "Custom end mark" }, r.qed === undefined ? "auto" : r.qed === "" ? "none" : "custom", value => {
      if (value === "auto") delete r.qed; else r.qed = value === "none" ? "" : r.qed || "□";
      mark.value = r.qed ?? ""; mark.disabled = value !== "custom";
    });
    mark = this.text(card, "End mark", r.qed ?? "", value => { r.qed = value; }, "e.g. □");
    mark.disabled = !r.qed;
    this.button(card, "Remove environment", () => { profile.environments = profile.environments.filter(rule => rule !== r); card.remove(); });
  }
}
