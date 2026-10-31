import { Events } from "./events";

const SECRET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Where secrets persist. setSecret is synchronous and plugins clear their own
// copy right after calling it (QuickAdd does), so `set` must have stored the
// value when it returns, and throws when it cannot.
export interface SecretBackend {
	load(): Record<string, string>;
	set(id: string, secret: string): void;
}

// Local secrets, kept out of plugin data and out of the vault. In justnotes the
// main process encrypts them with Electron safeStorage into the app's user
// data folder; they are all decrypted once at startup because getSecret is
// synchronous.
export class SecretStorage extends Events {
	#backend: SecretBackend;
	#secrets: Map<string, string> | undefined;

	constructor(backend: SecretBackend) {
		super();
		this.#backend = backend;
	}

	get #all() {
		this.#secrets ??= new Map(Object.entries(this.#backend.load()));
		return this.#secrets;
	}

	// An empty secret removes the id.
	setSecret(id: string, secret: string) {
		if (!SECRET_ID.test(id)) throw new Error(`Invalid secret id "${id}": use lowercase letters, digits and dashes`);
		this.#backend.set(id, secret);
		if (secret === "") this.#all.delete(id);
		else this.#all.set(id, secret);
		this.trigger("changed", id);
	}

	getSecret(id: string) {
		return this.#all.get(id) ?? null;
	}

	listSecrets() {
		return [...this.#all.keys()];
	}
}
