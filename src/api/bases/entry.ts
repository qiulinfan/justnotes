import type { TFile } from "../vault";
import type { BasesPropertyId } from "./property";
import { NullValue, type Value } from "./values";

// One row of a base: a vault file.
export class BasesEntry {
	file: TFile;

	constructor(file: TFile) {
		this.file = file;
	}

	getValue(_propertyId: BasesPropertyId): Value | null {
		return null;
	}
}

// The entries that share one value of the groupBy property.
export class BasesEntryGroup {
	key?: Value;
	entries: BasesEntry[];

	constructor(key: Value | undefined, entries: BasesEntry[] = []) {
		this.key = key;
		this.entries = entries;
	}

	hasKey() {
		return this.key !== undefined && !(this.key instanceof NullValue);
	}
}
