import type { App } from "../app";
import { Component, Events } from "../events";
import type { TFile, TFolder } from "../vault";
import { BasesViewConfig } from "./config";
import type { QueryController } from "./controller";
import type { BasesPropertyId } from "./property";
import { BasesQueryResult } from "./query";

// The base class of every Bases view, built-in or registered by a plugin. The
// controller sets `data` and `allProperties` and then calls onDataUpdated().
export abstract class BasesView extends Component {
	abstract type: string;
	app: App;
	config: BasesViewConfig;
	allProperties: BasesPropertyId[] = [];
	data: BasesQueryResult;
	#controller: QueryController;

	protected constructor(controller: QueryController) {
		super();
		this.#controller = controller;
		this.app = controller.app;
		this.config = controller.currentConfig ?? new BasesViewConfig();
		this.data = controller.currentResult ?? new BasesQueryResult();
		this.allProperties = controller.allProperties ?? [];
	}

	abstract onDataUpdated(): void;

	// Create a note for this view, named `baseFileName`, with the frontmatter
	// its filters imply, and open it.
	createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: any, file: TFile) => void): Promise<void> {
		return this.#controller.createFileForView(baseFileName, frontmatterProcessor);
	}
}

export type BasesViewFactory = (controller: QueryController, containerEl: HTMLElement) => BasesView;

interface BasesOption {
	key: string;
	type: string;
	displayName: string;
	shouldHide?: () => boolean;
}

export type BasesOptions =
	| (BasesOption & { type: "dropdown"; default?: string; options: Record<string, string> })
	| (BasesOption & { type: "file"; default?: string; placeholder?: string; filter?: (file: TFile) => boolean })
	| (BasesOption & { type: "folder"; default?: string; placeholder?: string; filter?: (folder: TFolder) => boolean })
	| (BasesOption & { type: "formula"; default?: string; placeholder?: string })
	| (BasesOption & { type: "multitext"; default?: string[] })
	| (BasesOption & { type: "property"; default?: string; placeholder?: string; filter?: (prop: BasesPropertyId) => boolean })
	| (BasesOption & { type: "slider"; default?: number; min?: number; max?: number; step?: number; instant?: boolean })
	| (BasesOption & { type: "text"; default?: string; placeholder?: string })
	| (BasesOption & { type: "toggle"; default?: boolean });

export interface BasesOptionGroup {
	type: "group";
	displayName: string;
	items: BasesOptions[];
	shouldHide?: () => boolean;
}

export type BasesAllOptions = BasesOptions | BasesOptionGroup;

export interface BasesViewRegistration {
	name: string;
	icon: string;
	factory: BasesViewFactory;
	options?: (config: BasesViewConfig) => BasesAllOptions[];
}

// View types by id: the built-in table, cards and list, then plugin views.
// `changed` fires with the id when one is added or removed.
const registrations = new Map<string, BasesViewRegistration>();
export const basesViewTypes = new Events();

export function registerBasesViewType(id: string, registration: BasesViewRegistration) {
	if (!id || registrations.has(id) || typeof registration?.factory !== "function") return false;
	registrations.set(id, registration);
	basesViewTypes.trigger("changed", id);
	return true;
}

export function unregisterBasesViewType(id: string) {
	if (registrations.delete(id)) basesViewTypes.trigger("changed", id);
}

export function getBasesViewType(id: string) {
	return registrations.get(id) ?? null;
}

export function listBasesViewTypes() {
	return [...registrations.entries()];
}
