import { describe, expect, test } from "bun:test";
import { type SecretBackend, SecretStorage } from "../src/api/secret-storage";

function memoryBackend(initial: Record<string, string> = {}) {
	const stored = { ...initial };
	const backend: SecretBackend = {
		load: () => ({ ...stored }),
		set: (id, secret) => {
			if (secret === "") delete stored[id];
			else stored[id] = secret;
		},
	};
	return { stored, backend };
}

describe("SecretStorage", () => {
	test("an id that is not lowercase alphanumeric with dashes throws and stores nothing", () => {
		const { stored, backend } = memoryBackend();
		const secrets = new SecretStorage(backend);
		for (const id of ["OpenAI", "my_key", "-key", "key-", "a--b", ""]) expect(() => secrets.setSecret(id, "x")).toThrow();
		expect(stored).toEqual({});
	});

	test("a secret is stored by the time setSecret returns, and an empty one removes it", () => {
		// QuickAdd clears the plaintext key from data.json right after setSecret.
		const { stored, backend } = memoryBackend({ "old-key": "a" });
		const secrets = new SecretStorage(backend);
		secrets.setSecret("openai-key", "sk-test");
		expect(stored["openai-key"]).toBe("sk-test");
		expect(secrets.getSecret("openai-key")).toBe("sk-test");
		secrets.setSecret("old-key", "");
		expect(secrets.getSecret("old-key")).toBeNull();
		expect(secrets.listSecrets()).toEqual(["openai-key"]);
	});

	test("when the backend cannot store a secret, setSecret throws and the secret is not kept", () => {
		const secrets = new SecretStorage({
			load: () => ({}),
			set: () => {
				throw new Error("Encrypted storage is not available on this device");
			},
		});
		expect(() => secrets.setSecret("api-key", "sk-test")).toThrow("not available");
		expect(secrets.getSecret("api-key")).toBeNull();
	});
});
