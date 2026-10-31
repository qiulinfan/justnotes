import type { App } from "../app";
import { Component } from "../events";

// Runs a base's query and keeps its view up to date.
export class QueryController extends Component {
	app: App;

	constructor(app: App) {
		super();
		this.app = app;
	}
}
