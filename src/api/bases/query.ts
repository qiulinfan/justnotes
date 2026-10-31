import { BasesEntry, BasesEntryGroup } from "./entry";
import type { BasesPropertyId } from "./property";
import { NullValue, type Value } from "./values";

// The result of running a base's query for one view.
export class BasesQueryResult {
	data: BasesEntry[] = [];

	get groupedData() {
		return [new BasesEntryGroup(undefined, this.data)];
	}

	get properties(): BasesPropertyId[] {
		return [];
	}

	getSummaryValue(_queryController: unknown, _entries: BasesEntry[], _prop: BasesPropertyId, _summaryKey: string): Value {
		return NullValue.value;
	}
}
