import moment from "moment";
import type { App } from "../app";
import { setIcon } from "../icons";
import { Modal } from "./modal";
import { Notice } from "./notice";
import { setTooltip, type TooltipOptions } from "./tooltip";

export class BaseComponent {
	disabled = false;

	then(cb: (component: this) => any) {
		cb(this);
		return this;
	}

	setDisabled(disabled: boolean) {
		this.disabled = disabled;
		return this;
	}
}

export abstract class ValueComponent<T> extends BaseComponent {
	registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string) {
		listeners[key] = (value?: T) => {
			if (value !== undefined) this.setValue(value);
			return this.getValue();
		};
		return this;
	}

	abstract getValue(): T;
	abstract setValue(value: T): this;
}

export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
	inputEl: T;
	#onChange: ((value: string) => any) | null = null;

	constructor(inputEl: T) {
		super();
		this.inputEl = inputEl;
		inputEl.addEventListener("input", () => this.onChanged());
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.inputEl.disabled = disabled;
		return this;
	}

	getValue() {
		return this.inputEl.value;
	}

	setValue(value: string) {
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(placeholder: string) {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	onChanged() {
		this.#onChange?.(this.getValue());
	}

	onChange(cb: (value: string) => any) {
		this.#onChange = cb;
		return this;
	}
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl("input", { type: "text", attr: { spellcheck: "false" } }));
	}
}

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
	clearButtonEl: HTMLElement;
	containerEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		const wrap = containerEl.createDiv("search-input-container");
		super(wrap.createEl("input", { type: "search", attr: { enterkeyhint: "search", spellcheck: "false" } }));
		this.containerEl = wrap;
		// CSS hides the button while the placeholder shows, as Obsidian does.
		this.clearButtonEl = wrap.createDiv("search-input-clear-button");
		this.clearButtonEl.addEventListener("click", () => {
			this.setValue("");
			this.onChanged();
			this.inputEl.focus();
		});
	}
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl("textarea", { attr: { spellcheck: "false" } }));
	}
}

export class MomentFormatComponent extends TextComponent {
	sampleEl: HTMLElement | null = null;
	defaultFormat = "";

	setDefaultFormat(format: string) {
		this.defaultFormat = format;
		this.setPlaceholder(format);
		this.updateSample();
		return this;
	}

	setSampleEl(el: HTMLElement) {
		this.sampleEl = el;
		this.updateSample();
		return this;
	}

	setValue(value: string) {
		super.setValue(value);
		this.updateSample();
		return this;
	}

	onChanged() {
		this.updateSample();
		super.onChanged();
	}

	updateSample() {
		this.sampleEl?.setText(moment().format(this.getValue() || this.defaultFormat));
	}
}

export class ToggleComponent extends ValueComponent<boolean> {
	toggleEl: HTMLElement;
	#inputEl: HTMLInputElement;
	#value = false;
	#onChange: ((value: boolean) => any) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.toggleEl = containerEl.createEl("label", { cls: "checkbox-container", attr: { tabindex: "0" } });
		this.#inputEl = this.toggleEl.createEl("input", { type: "checkbox", attr: { tabindex: "-1" } });
		this.toggleEl.addEventListener("click", (evt) => {
			// The label would also toggle the input and click it a second time.
			evt.preventDefault();
			this.onClick(evt);
		});
		this.toggleEl.addEventListener("keydown", (evt) => {
			if (evt.key !== " " && evt.key !== "Enter") return;
			evt.preventDefault();
			this.onClick(evt);
		});
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.toggleEl.toggleClass("is-disabled", disabled);
		return this;
	}

	getValue() {
		return this.#value;
	}

	// Like Obsidian, a change of value notifies onChange, whoever made it.
	setValue(on: boolean) {
		const changed = on !== this.#value;
		this.#value = on;
		this.#inputEl.checked = on;
		this.toggleEl.toggleClass("is-enabled", on);
		if (changed) this.#onChange?.(on);
		return this;
	}

	setTooltip(tooltip: string, options?: TooltipOptions) {
		setTooltip(this.toggleEl, tooltip, options);
		return this;
	}

	onClick(_evt?: Event) {
		if (this.disabled) return;
		this.setValue(!this.#value);
	}

	onChange(cb: (value: boolean) => any) {
		this.#onChange = cb;
		return this;
	}
}

export class DropdownComponent extends ValueComponent<string> {
	selectEl: HTMLSelectElement;
	#onChange: ((value: string) => any) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.selectEl = containerEl.createEl("select", "dropdown");
		this.selectEl.addEventListener("change", () => this.#onChange?.(this.getValue()));
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.selectEl.disabled = disabled;
		return this;
	}

	addOption(value: string, display: string) {
		this.selectEl.createEl("option", { value, text: display });
		return this;
	}

	addOptions(options: Record<string, string>) {
		for (const [v, d] of Object.entries(options)) this.addOption(v, d);
		return this;
	}

	getValue() {
		return this.selectEl.value;
	}

	setValue(value: string) {
		this.selectEl.value = value;
		return this;
	}

	onChange(cb: (value: string) => any) {
		this.#onChange = cb;
		return this;
	}
}

export class SliderComponent extends ValueComponent<number> {
	sliderEl: HTMLInputElement;
	#valueEl: HTMLElement;
	#format: (value: number) => string = String;
	#onChange: ((value: number) => any) | null = null;
	#instant = false;

	constructor(containerEl: HTMLElement) {
		super();
		// The value shows inline before the slider; plugin CSS reorders it.
		this.#valueEl = containerEl.createSpan("slider-value");
		this.sliderEl = containerEl.createEl("input", { type: "range", cls: "slider", attr: { "data-ignore-swipe": "true" } });
		const fire = () => this.#onChange?.(this.getValue());
		this.sliderEl.addEventListener("input", () => {
			this.#sync();
			if (this.#instant) fire();
		});
		this.sliderEl.addEventListener("change", () => {
			this.#sync();
			fire();
		});
		this.#sync();
	}

	#sync() {
		this.#valueEl.setText(this.getValuePretty());
		const min = Number(this.sliderEl.min || 0);
		const max = Number(this.sliderEl.max || 100);
		const ratio = max > min ? (this.getValue() - min) / (max - min) : 0;
		this.sliderEl.style.setProperty("--slider-fill-ratio", String(Math.min(1, Math.max(0, ratio))));
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.sliderEl.disabled = disabled;
		return this;
	}

	setInstant(instant: boolean) {
		this.#instant = instant;
		return this;
	}

	setLimits(min: number | null, max: number | null, step: number | "any") {
		if (min !== null) this.sliderEl.min = String(min);
		if (max !== null) this.sliderEl.max = String(max);
		this.sliderEl.step = String(step);
		this.#sync();
		return this;
	}

	// An empty string hides the inline value.
	setDisplayFormat(format: (value: number) => string) {
		this.#format = format;
		this.#sync();
		return this;
	}

	// Deprecated in Obsidian: the value is always shown inline now.
	setDynamicTooltip() {
		return this;
	}

	showTooltip() {}

	getValuePretty() {
		return this.#format(this.getValue());
	}

	getValue() {
		return Number(this.sliderEl.value);
	}

	setValue(value: number) {
		this.sliderEl.value = String(value);
		this.#sync();
		return this;
	}

	onChange(cb: (value: number) => any) {
		this.#onChange = cb;
		return this;
	}
}

export interface RGB {
	r: number;
	g: number;
	b: number;
}

export interface HSL {
	h: number;
	s: number;
	l: number;
}

export class ColorComponent extends ValueComponent<string> {
	colorPickerEl: HTMLInputElement;
	#onChange: ((value: string) => any) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.colorPickerEl = containerEl.createEl("input", { type: "color" });
		this.colorPickerEl.addEventListener("input", () => this.#onChange?.(this.getValue()));
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.colorPickerEl.disabled = disabled;
		return this;
	}

	getValue() {
		return this.colorPickerEl.value;
	}

	getValueRgb() {
		return { ...hexToRgb(this.getValue()), a: 1 };
	}

	// Saturation and lightness are percentages, as in Obsidian.
	getValueHsl(): HSL {
		return rgbToHsl(hexToRgb(this.getValue()));
	}

	setValue(value: string) {
		this.colorPickerEl.value = value;
		return this;
	}

	setValueRgb(rgb: RGB) {
		return this.setValue(rgbToHex(rgb));
	}

	setValueHsl(hsl: HSL) {
		return this.setValue(rgbToHex(hslToRgb(hsl)));
	}

	onChange(cb: (value: string) => any) {
		this.#onChange = cb;
		return this;
	}
}

function hexToRgb(hex: string): RGB {
	let h = hex.replace(/^#/, "");
	if (h.length === 3) h = [...h].map((c) => c + c).join("");
	const n = Number.parseInt(h.slice(0, 6), 16) || 0;
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: RGB) {
	const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
	return `#${part(r)}${part(g)}${part(b)}`;
}

function rgbToHsl({ r, g, b }: RGB): HSL {
	const [rr, gg, bb] = [r / 255, g / 255, b / 255];
	const max = Math.max(rr, gg, bb);
	const min = Math.min(rr, gg, bb);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return { h: 0, s: 0, l: l * 100 };
	const s = d / (1 - Math.abs(2 * l - 1));
	const h = max === rr ? ((gg - bb) / d + 6) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
	return { h: h * 60, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }: HSL): RGB {
	const ss = s / 100;
	const ll = l / 100;
	const c = (1 - Math.abs(2 * ll - 1)) * ss;
	const hh = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hh % 2) - 1));
	const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
	const m = ll - c / 2;
	return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export class ProgressBarComponent extends ValueComponent<number> {
	progressBar: HTMLElement;
	#lineEl: HTMLElement;
	#value = 0;

	constructor(containerEl: HTMLElement) {
		super();
		this.progressBar = containerEl.createDiv("setting-progress-bar");
		this.#lineEl = this.progressBar.createDiv("setting-progress-bar-inner");
	}

	getValue() {
		return this.#value;
	}

	setValue(value: number) {
		this.#value = value;
		this.#lineEl.style.width = `${value}%`;
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	buttonEl: HTMLButtonElement;
	#onClick: ((evt: MouseEvent) => any) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.buttonEl = containerEl.createEl("button");
		this.buttonEl.addEventListener("click", (evt) => this.#onClick?.(evt));
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.buttonEl.disabled = disabled;
		return this;
	}

	setCta() {
		this.buttonEl.addClass("mod-cta");
		return this;
	}

	removeCta() {
		this.buttonEl.removeClass("mod-cta");
		return this;
	}

	setDestructive() {
		this.buttonEl.addClass("mod-destructive");
		return this;
	}

	removeDestructive() {
		this.buttonEl.removeClass("mod-destructive");
		return this;
	}

	// Deprecated in Obsidian 1.13, where it became a destructive primary button.
	setWarning() {
		return this.setDestructive().setCta();
	}

	setTooltip(tooltip: string, options?: TooltipOptions) {
		setTooltip(this.buttonEl, tooltip, options);
		return this;
	}

	setButtonText(name: string) {
		this.buttonEl.setText(name);
		return this;
	}

	setIcon(icon: string) {
		setIcon(this.buttonEl, icon);
		return this;
	}

	setClass(cls: string) {
		this.buttonEl.addClasses(cls.split(/\s+/));
		return this;
	}

	onClick(cb: (evt: MouseEvent) => any) {
		this.#onClick = cb;
		return this;
	}
}

export class ExtraButtonComponent extends BaseComponent {
	extraSettingsEl: HTMLElement;
	#onClick: (() => any) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.extraSettingsEl = containerEl.createDiv({ cls: "clickable-icon extra-setting-button", attr: { tabindex: "0" } });
		this.extraSettingsEl.addEventListener("click", () => !this.disabled && this.#onClick?.());
		this.extraSettingsEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			if (!this.disabled) this.#onClick?.();
		});
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.extraSettingsEl.toggleClass("is-disabled", disabled);
		return this;
	}

	setTooltip(tooltip: string, options?: TooltipOptions) {
		setTooltip(this.extraSettingsEl, tooltip, options);
		return this;
	}

	setIcon(icon: string) {
		setIcon(this.extraSettingsEl, icon);
		return this;
	}

	onClick(cb: () => any) {
		this.#onClick = cb;
		return this;
	}
}

// A read-only value on a row, with an optional warning indicator.
export class DisplayValueComponent {
	valueEl: HTMLElement;
	#statusEl: HTMLElement | null = null;

	constructor(containerEl: HTMLElement) {
		this.valueEl = containerEl.createDiv("setting-item-value");
	}

	setValue(value: string | null) {
		this.valueEl.setText(value ?? "");
		return this;
	}

	setStatus(status: "warning" | null) {
		if (status !== "warning") {
			this.#statusEl?.detach();
			this.#statusEl = null;
		} else if (!this.#statusEl) {
			this.#statusEl = createDiv("setting-item-status mod-warning");
			setIcon(this.#statusEl, "alert-triangle");
			this.valueEl.insertAdjacentElement("afterend", this.#statusEl);
		}
		return this;
	}
}

// What SecretComponent needs from app.secretStorage.
interface SecretStore {
	listSecrets(): string[];
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

const SECRET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Links a setting to a secret in app.secretStorage: the setting keeps the
// secret's id, and the value never reaches the plugin through this component.
export class SecretComponent extends BaseComponent {
	app: App;
	#value = "";
	#valueEl: HTMLElement;
	#buttonEl: HTMLButtonElement;
	#onChange: ((value: string | null) => unknown) | null = null;

	constructor(app: App, containerEl: HTMLElement) {
		super();
		this.app = app;
		const warning = containerEl.createDiv({ cls: "clickable-icon mod-warning", attr: { "aria-label": "Secrets are not encrypted" } });
		setIcon(warning, "alert-triangle");
		warning.hide();
		this.#valueEl = containerEl.createDiv("setting-secret-value");
		this.#buttonEl = containerEl.createEl("button", { text: "Link..." });
		this.#buttonEl.addEventListener("click", () => this.#pick());
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.#buttonEl.disabled = disabled;
		return this;
	}

	setValue(value: string) {
		this.#value = value ?? "";
		this.#valueEl.setText(this.#value);
		return this;
	}

	onChange(cb: (value: string | null) => unknown) {
		this.#onChange = cb;
		return this;
	}

	#pick() {
		const store = (this.app as App & { secretStorage?: SecretStore }).secretStorage;
		if (!store) {
			new Notice("Secret storage is not available.");
			return;
		}
		const choose = (id: string) => {
			this.setValue(id);
			this.#onChange?.(id);
		};
		if (store.listSecrets().length === 0) new AddSecretModal(this.app, store, choose).open();
		else new SelectSecretModal(this.app, store, this.#value, choose).open();
	}
}

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: BaseComponent[] = [];
	errorEl: HTMLElement | null = null;

	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item", attr: { tabindex: "-1" } });
		this.infoEl = this.settingEl.createDiv("setting-item-info");
		this.nameEl = this.infoEl.createDiv("setting-item-name");
		this.descEl = this.infoEl.createDiv("setting-item-description");
		this.controlEl = this.settingEl.createDiv("setting-item-control");
	}

	setName(name: string | DocumentFragment) {
		this.nameEl.setText(name);
		return this;
	}

	setDesc(desc: string | DocumentFragment) {
		this.descEl.setText(desc);
		return this;
	}

	setClass(cls: string) {
		this.settingEl.addClasses(cls.split(/\s+/));
		return this;
	}

	setTooltip(tooltip: string, options?: TooltipOptions) {
		setTooltip(this.nameEl, tooltip, options);
		return this;
	}

	setHeading() {
		this.settingEl.addClass("setting-item-heading");
		return this;
	}

	setDisabled(disabled: boolean) {
		this.settingEl.toggleClass("is-disabled", disabled);
		for (const c of this.components) c.setDisabled(disabled);
		return this;
	}

	// A persistent validation message below the controls; null or "" clears it.
	setErrorMessage(message: string | null) {
		if (!message) {
			this.settingEl.removeClass("is-invalid");
			this.errorEl?.hide();
			return this;
		}
		this.errorEl ??= this.controlEl.createDiv("setting-item-error");
		this.errorEl.setText(message);
		this.errorEl.show();
		this.settingEl.addClass("is-invalid");
		return this;
	}

	addDisplayValue(cb: (component: DisplayValueComponent) => any) {
		cb(new DisplayValueComponent(this.controlEl));
		return this;
	}

	#add<C extends BaseComponent>(component: C, cb: (c: C) => any) {
		this.components.push(component);
		cb(component);
		return this;
	}

	addButton(cb: (c: ButtonComponent) => any) {
		return this.#add(new ButtonComponent(this.controlEl), cb);
	}

	addExtraButton(cb: (c: ExtraButtonComponent) => any) {
		return this.#add(new ExtraButtonComponent(this.controlEl), cb);
	}

	addToggle(cb: (c: ToggleComponent) => any) {
		this.settingEl.addClass("mod-toggle");
		return this.#add(new ToggleComponent(this.controlEl), cb);
	}

	addText(cb: (c: TextComponent) => any) {
		return this.#add(new TextComponent(this.controlEl), cb);
	}

	addSearch(cb: (c: SearchComponent) => any) {
		return this.#add(new SearchComponent(this.controlEl), cb);
	}

	addTextArea(cb: (c: TextAreaComponent) => any) {
		return this.#add(new TextAreaComponent(this.controlEl), cb);
	}

	addMomentFormat(cb: (c: MomentFormatComponent) => any) {
		return this.#add(new MomentFormatComponent(this.controlEl), cb);
	}

	addDropdown(cb: (c: DropdownComponent) => any) {
		return this.#add(new DropdownComponent(this.controlEl), cb);
	}

	addColorPicker(cb: (c: ColorComponent) => any) {
		return this.#add(new ColorComponent(this.controlEl), cb);
	}

	addProgressBar(cb: (c: ProgressBarComponent) => any) {
		return this.#add(new ProgressBarComponent(this.controlEl), cb);
	}

	addSlider(cb: (c: SliderComponent) => any) {
		return this.#add(new SliderComponent(this.controlEl), cb);
	}

	addComponent<C extends BaseComponent>(factory: (el: HTMLElement) => C) {
		this.components.push(factory(this.controlEl));
		return this;
	}

	then(cb: (setting: this) => any) {
		cb(this);
		return this;
	}

	clear() {
		this.controlEl.empty();
		this.components = [];
		this.errorEl = null;
		return this;
	}
}

// Obsidian 1.11 groups settings under an optional heading, whose control
// area holds the extra buttons; the search row sits between it and the list.
export class SettingGroup {
	containerEl: HTMLElement;
	listEl: HTMLElement;
	#searchEl: HTMLElement;
	#heading: { nameEl: HTMLElement; controlEl: HTMLElement } | null = null;

	constructor(containerEl: HTMLElement) {
		this.containerEl = containerEl.createDiv("setting-group");
		this.#searchEl = this.containerEl.createDiv({ cls: "setting-group-search", attr: { tabindex: "-1" } });
		this.listEl = this.containerEl.createDiv("setting-items");
	}

	#headingEls() {
		if (!this.#heading) {
			const el = createDiv("setting-item setting-item-heading");
			this.containerEl.prepend(el);
			this.#heading = { nameEl: el.createDiv("setting-item-name"), controlEl: el.createDiv("setting-item-control") };
		}
		return this.#heading;
	}

	setHeading(text: string | DocumentFragment) {
		this.#headingEls().nameEl.setText(text);
		return this;
	}

	addClass(...classes: string[]) {
		this.containerEl.addClass(...classes);
		return this;
	}

	addSetting(cb: (setting: Setting) => any) {
		cb(new Setting(this.listEl));
		return this;
	}

	addSearch(cb: (component: SearchComponent) => any) {
		cb(new SearchComponent(this.#searchEl));
		return this;
	}

	addExtraButton(cb: (component: ExtraButtonComponent) => any) {
		cb(new ExtraButtonComponent(this.#headingEls().controlEl));
		return this;
	}
}

// A sub-page pushed inside a settings tab (Obsidian 1.13). The settings modal
// fills the titlebar with a back button and the title when it opens the page.
export abstract class SettingPage {
	rootEl: HTMLElement;
	titlebarEl: HTMLElement;
	containerEl: HTMLElement;
	title = "";

	constructor() {
		this.rootEl = createDiv("setting-page vertical-tab-content");
		this.titlebarEl = this.rootEl.createDiv("setting-page-titlebar");
		this.containerEl = this.rootEl.createDiv("setting-page-content");
	}

	abstract display(): void;

	hide() {
		this.containerEl.empty();
	}
}

const initialFocus = new WeakMap<ConfirmationModal, ConfirmationButton>();

// A button in a ConfirmationModal: the modal closes once the click handler
// resolves, unless the handler returns something truthy.
export class ConfirmationButton extends ButtonComponent {
	#modal: ConfirmationModal;
	#handler: ((evt: MouseEvent) => unknown) | null = null;

	constructor(containerEl: HTMLElement, modal: ConfirmationModal) {
		super(containerEl);
		this.#modal = modal;
		super.onClick(async (evt) => {
			this.setDisabled(true);
			let keepOpen: unknown;
			try {
				// Only real promises are awaited: components have then() and
				// would never settle.
				const result = this.#handler?.(evt);
				keepOpen = result instanceof Promise ? await result : result;
			} catch (err) {
				console.error(err);
				keepOpen = true;
			} finally {
				this.setDisabled(false);
			}
			if (!keepOpen) modal.close();
		});
	}

	onClick(handler: (evt: MouseEvent) => unknown) {
		this.#handler = handler;
		return this;
	}

	setInitialFocus() {
		initialFocus.set(this.#modal, this);
		return this;
	}

	setSecondary() {
		this.buttonEl.addClass("mod-secondary");
		return this;
	}

	setCancel() {
		this.buttonEl.addClass("mod-cancel");
		return this;
	}
}

export class ConfirmationModal extends Modal {
	buttonContainerEl: HTMLElement;

	constructor(app: App) {
		super(app);
		this.containerEl.addClass("mod-confirmation");
		this.buttonContainerEl = this.modalEl.createDiv("modal-button-container");
	}

	open() {
		super.open();
		initialFocus.get(this)?.buttonEl.focus();
	}

	addClass(cls: string) {
		this.modalEl.addClasses(cls.split(/\s+/));
		return this;
	}

	addCheckbox(label: string, cb: (value: boolean) => any) {
		const labelEl = this.buttonContainerEl.createEl("label", "mod-checkbox");
		const input = labelEl.createEl("input", { type: "checkbox", attr: { tabindex: "-1" } });
		labelEl.appendText(label);
		input.addEventListener("change", () => cb(input.checked));
		return this;
	}

	addButton(cb: (btn: ConfirmationButton) => any) {
		cb(new ConfirmationButton(this.buttonContainerEl, this));
		return this;
	}

	addCancelButton(text = "Cancel") {
		return this.addButton((btn) => btn.setButtonText(text).setCancel());
	}
}

class AddSecretModal extends ConfirmationModal {
	constructor(app: App, store: SecretStore, done: (id: string) => void) {
		super(app);
		this.setTitle("Add secret");
		let id = "";
		let secret = "";
		const idRow = new Setting(this.contentEl)
			.setName("ID")
			.setDesc("Lowercase letters, numbers and dashes only.")
			.addText((text) => {
				text.inputEl.setAttr("autocapitalize", "off");
				text.setPlaceholder("secret-name").onChange((value) => (id = value.trim()));
			});
		const secretRow = new Setting(this.contentEl).setName("Secret").setDesc("Enter your secret.");
		let input: HTMLInputElement;
		secretRow.addExtraButton((button) => {
			button.setIcon("eye-off").setTooltip("Show secret");
			button.onClick(() => {
				const hidden = input.type === "password";
				input.type = hidden ? "text" : "password";
				button.setIcon(hidden ? "eye" : "eye-off").setTooltip(hidden ? "Hide secret" : "Show secret");
			});
		});
		secretRow.addText((text) => {
			input = text.inputEl;
			input.type = "password";
			input.setAttr("autocomplete", "off");
			text.setPlaceholder("sk-...").onChange((value) => (secret = value));
		});
		this.addCancelButton();
		this.addButton((btn) =>
			btn
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					idRow.setErrorMessage(SECRET_ID.test(id) ? null : "Use lowercase letters, numbers and dashes.");
					secretRow.setErrorMessage(secret ? null : "Enter the secret.");
					if (!SECRET_ID.test(id) || !secret) return true;
					try {
						store.setSecret(id, secret);
					} catch (err) {
						idRow.setErrorMessage(err instanceof Error ? err.message : String(err));
						return true;
					}
					done(id);
				}),
		);
	}
}

class SelectSecretModal extends ConfirmationModal {
	#store: SecretStore;
	#listEl: HTMLElement;
	#selected: string;
	#filter = "";

	constructor(app: App, store: SecretStore, current: string, done: (id: string) => void) {
		super(app);
		this.#store = store;
		this.#selected = current;
		this.setTitle("Select secret");
		this.modalEl.addClass("mod-secret");
		const toolbar = this.titleEl.parentElement!.createDiv("suggestion-filter-toolbar");
		new SearchComponent(toolbar).setPlaceholder("Find secret...").onChange((value) => {
			this.#filter = value.toLowerCase();
			this.#render();
		});
		this.#listEl = this.contentEl.createDiv("keychain-list-results");
		this.addButton((btn) =>
			btn
				.setButtonText("Add secret...")
				.setSecondary()
				.onClick(() => {
					new AddSecretModal(app, store, (id) => {
						done(id);
						this.close();
					}).open();
					return true;
				}),
		);
		this.addButton((btn) =>
			btn
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					if (!this.#selected) return true;
					done(this.#selected);
				}),
		);
		this.addCancelButton();
		this.#render();
	}

	#render() {
		this.#listEl.empty();
		for (const id of this.#store.listSecrets()) {
			if (this.#filter && !id.includes(this.#filter)) continue;
			const row = this.#listEl.createDiv("suggestion-item mod-complex suggestion-secret-key");
			row.toggleClass("is-selected", id === this.#selected);
			const radio = row.createEl("input", { type: "radio" });
			radio.checked = id === this.#selected;
			row.createDiv("suggestion-content").createDiv({ cls: "suggestion-title", text: id });
			const aux = row.createDiv("suggestion-aux");
			const text = aux.createDiv({ cls: "suggestion-secret-text", text: "•••••••" });
			const reveal = aux.createDiv("clickable-icon");
			setIcon(reveal, "eye-off");
			reveal.addEventListener("click", (evt) => {
				evt.stopPropagation();
				const shown = text.getText() !== "•••••••";
				text.setText(shown ? "•••••••" : (this.#store.getSecret(id) ?? ""));
				setIcon(reveal, shown ? "eye-off" : "eye");
			});
			const remove = aux.createDiv("clickable-icon");
			setIcon(remove, "trash-2");
			remove.addEventListener("click", (evt) => {
				evt.stopPropagation();
				// SecretStorage has no delete; an empty value removes the secret.
				this.#store.setSecret(id, "");
				if (this.#selected === id) this.#selected = "";
				this.#render();
			});
			row.addEventListener("click", () => {
				this.#selected = id;
				this.#render();
			});
		}
	}
}
