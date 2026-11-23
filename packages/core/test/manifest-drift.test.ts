/** The manifest's settings defaults (what the EmDash form pre-fills) must equal the code's. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_DEFAULTS } from "../src/settings.js";

const jsonc = readFileSync(new URL("../emdash-plugin.jsonc", import.meta.url), "utf8")
	.replace(/^\s*\/\/.*$/gm, "")
	.replace(/,(\s*[}\]])/g, "$1");
const manifest = JSON.parse(jsonc) as {
	settingsSchema?: Record<string, { default?: unknown }>;
	admin?: { settingsSchema?: Record<string, { default?: unknown }> };
};
const schema = manifest.settingsSchema ?? manifest.admin?.settingsSchema ?? {};

describe("manifest settings defaults", () => {
	for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
		it(`${k} matches the code default`, () => expect(schema[k]?.default).toBe(v));
	}
	it("the default success URL keeps the order key in the fragment", () => {
		expect(String(schema["successUrl"]?.default)).toMatch(/#key=\{ORDER_KEY\}$/);
	});
});

describe("manifest storage", () => {
	it("declares exactly the collections and indexes the code uses", async () => {
		const { COLLECTIONS } = await import("../src/model.js");
		const storage = (JSON.parse(jsonc) as { storage: Record<string, { indexes: unknown[] }> })
			.storage;
		expect(Object.keys(storage).toSorted()).toEqual(Object.keys(COLLECTIONS).toSorted());
		for (const [name, c] of Object.entries(COLLECTIONS))
			expect(storage[name]!.indexes).toEqual([...c.indexes]);
	});
});
