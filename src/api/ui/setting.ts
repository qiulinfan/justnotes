import moment from "moment";
import { setIcon, setTooltip } from "../icons";

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
		super(containerEl.createEl("input", { type: "text" }));
	}
}

export class SecretComponent extends AbstractTextComponent<HTMLInputElement> {
	constructor(_app: any, containerEl: HTMLElement) {
		super(containerEl.createEl("input", { type: "password" }));
	}
}

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
	clearButtonEl: HTMLElement;
	containerEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		const wrap = containerEl.createDiv("search-input-container");
		super(wrap.createEl("input", { type: "search" }));
		this.containerEl = wrap;
		this.clearButtonEl = wrap.createDiv("search-input-clear-button");
		this.clearButtonEl.addEventListener("click", () => {
			this.setValue("");
			this.onChanged();
		});
	}
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl("textarea"));
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
	#value = false;
	#onChange: ((value: boolean) => any) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.toggleEl = containerEl.createDiv("checkbox-container");
		this.toggleEl.createEl("input", { type: "checkbox" });
		this.toggleEl.addEventListener("click", (evt) => this.onClick(evt));
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.toggleEl.toggleClass("is-disabled", disabled);
		return this;
	}

	getValue() {
		return this.#value;
	}

	setValue(on: boolean) {
		this.#value = on;
		this.toggleEl.toggleClass("is-enabled", on);
		return this;
	}

	setTooltip(tooltip: string) {
		setTooltip(this.toggleEl, tooltip);
		return this;
	}

	onClick(_evt?: Event) {
		if (this.disabled) return;
		this.setValue(!this.#value);
		this.#onChange?.(this.#value);
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
	#onChange: ((value: number) => any) | null = null;
	#instant = false;

	constructor(containerEl: HTMLElement) {
		super();
		this.sliderEl = containerEl.createEl("input", { type: "range", cls: "slider" });
		const fire = () => this.#onChange?.(this.getValue());
		this.sliderEl.addEventListener("input", () => this.#instant && fire());
		this.sliderEl.addEventListener("change", fire);
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
		return this;
	}

	setDynamicTooltip() {
		this.sliderEl.addEventListener("input", () => setTooltip(this.sliderEl, String(this.getValue())));
		return this;
	}

	showTooltip() {}

	getValuePretty() {
		return String(this.getValue());
	}

	getValue() {
		return Number(this.sliderEl.value);
	}

	setValue(value: number) {
		this.sliderEl.value = String(value);
		return this;
	}

	onChange(cb: (value: number) => any) {
		this.#onChange = cb;
		return this;
	}
}

export class ColorComponent extends ValueComponent<string> {
	colorPickerEl: HTMLInputElement;
	#onChange: ((value: string) => any) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.colorPickerEl = containerEl.createEl("input", { type: "color" });
		this.colorPickerEl.addEventListener("input", () => this.#onChange?.(this.getValue()));
	}

	getValue() {
		return this.colorPickerEl.value;
	}

	setValue(value: string) {
		this.colorPickerEl.value = value;
		return this;
	}

	onChange(cb: (value: string) => any) {
		this.#onChange = cb;
		return this;
	}
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

	setWarning() {
		this.buttonEl.addClass("mod-warning");
		return this;
	}

	setTooltip(tooltip: string) {
		setTooltip(this.buttonEl, tooltip);
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
		this.buttonEl.addClass(cls);
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
		this.extraSettingsEl = containerEl.createDiv("clickable-icon extra-setting-button");
		this.extraSettingsEl.addEventListener("click", () => !this.disabled && this.#onClick?.());
	}

	setDisabled(disabled: boolean) {
		super.setDisabled(disabled);
		this.extraSettingsEl.toggleClass("is-disabled", disabled);
		return this;
	}

	setTooltip(tooltip: string) {
		setTooltip(this.extraSettingsEl, tooltip);
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

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: BaseComponent[] = [];

	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv("setting-item");
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
		this.settingEl.addClass(cls);
		return this;
	}

	setTooltip(tooltip: string) {
		setTooltip(this.nameEl, tooltip);
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
		return this;
	}
}

// Obsidian 1.11 groups settings under an optional heading.
export class SettingGroup {
	containerEl: HTMLElement;
	listEl: HTMLElement;
	#headerEl: HTMLElement;
	#headingEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.containerEl = containerEl.createDiv("setting-group");
		this.#headerEl = this.containerEl.createDiv("setting-group-header");
		this.#headingEl = this.#headerEl.createDiv("setting-item setting-item-heading");
		this.#headingEl.hide();
		this.listEl = this.containerEl.createDiv("setting-items");
	}

	setHeading(text: string | DocumentFragment) {
		this.#headingEl.show();
		this.#headingEl.setText(text);
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
		cb(new SearchComponent(this.#headerEl));
		return this;
	}

	addExtraButton(cb: (component: ExtraButtonComponent) => any) {
		cb(new ExtraButtonComponent(this.#headerEl));
		return this;
	}
}

// A sub-page pushed inside a settings tab (Obsidian 1.13).
export abstract class SettingPage {
	rootEl: HTMLElement;
	titlebarEl: HTMLElement;
	containerEl: HTMLElement;
	title = "";

	constructor() {
		this.rootEl = createDiv("setting-page");
		this.titlebarEl = this.rootEl.createDiv("setting-page-titlebar");
		this.containerEl = this.rootEl.createDiv("setting-page-content");
	}

	abstract display(): void;

	hide() {
		this.containerEl.empty();
	}
}
