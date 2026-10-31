import { type BasesPropertyId, normalizePropertyId, parsePropertyId } from "./property";
import { NullValue, type Value } from "./values";

export interface BasesSortConfig {
	property: BasesPropertyId;
	direction: "ASC" | "DESC";
}

// One entry of a base's `views` list, as plugin views see it.
export class BasesViewConfig {
	#view: Record<string, any>;

	constructor(view: Record<string, any> = {}) {
		this.#view = view;
	}

	get name(): string {
		return String(this.#view.name ?? "");
	}

	get(key: string): unknown {
		return this.#view[key];
	}

	getAsPropertyId(key: string): BasesPropertyId | null {
		return normalizePropertyId(this.#view[key]);
	}

	getEvaluatedFormula(_view: unknown, _key: string): Value {
		return NullValue.value;
	}

	set(key: string, value: any | null) {
		if (value === null || value === undefined) delete this.#view[key];
		else this.#view[key] = value;
	}

	getOrder(): BasesPropertyId[] {
		return [];
	}

	getSort(): BasesSortConfig[] {
		return [];
	}

	getDisplayName(propertyId: BasesPropertyId) {
		return parsePropertyId(propertyId).name;
	}
}
