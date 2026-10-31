import type { App } from "../app";
import { Component } from "../events";
import type { TFile } from "../vault";
import { BasesViewConfig } from "./config";
import type { QueryController } from "./controller";
import type { BasesPropertyId } from "./property";
import { BasesQueryResult } from "./query";

// The base class of every Bases view, built-in or registered by a plugin.
export abstract class BasesView extends Component {
	abstract type: string;
	app: App;
	config: BasesViewConfig;
	allProperties: BasesPropertyId[] = [];
	data: BasesQueryResult;

	protected constructor(controller: QueryController) {
		super();
		this.app = controller.app;
		this.config = new BasesViewConfig();
		this.data = new BasesQueryResult();
	}

	abstract onDataUpdated(): void;

	async createFileForView(_baseFileName?: string, _frontmatterProcessor?: (frontmatter: any, file: TFile) => void) {}
}
