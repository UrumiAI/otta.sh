/**
 * ADR-0032 — EmDash 1.0.1's encrypted plugin settings, asserted on the RAW
 * `options` rows of a real database. Shared by the sqlite/Postgres suite
 * (`plugin-secret-settings.dialects.test.ts`) and the D1 suite
 * (`d1/plugin-secret-settings.d1.spec.ts`); only the database differs.
 *
 * What it pins is the host behaviour Otta's payment keys rely on: a setting
 * declared `type: "secret"` is written as an AES-GCM envelope (never the
 * value), a value written before the declaration still reads, one conditional
 * re-save at its revision replaces that row in place, and without the right
 * key nothing is written and nothing is read.
 *
 * THE FIELD NAMES ARE OTTA'S: the `settings:*` names of the four payment keys
 * in `@otta-sh/plugin`'s `PAYMENT_SECRET_SETTINGS_SCHEMA`. They are restated
 * here because this package must not import the plugin; the site's
 * `site-config.test.ts` pins the plugin's schema to the deployed descriptor,
 * and `sites/staging/test/payment-secrets-at-rest.test.ts` runs the plugin's
 * own migration over the same host layer.
 */
import {
	createSettingsAccess,
	isEncryptedPluginSetting,
	OptionsRepository,
	resolvePluginEncryptionKeys,
} from "emdash";
import type { runMigrations } from "emdash/db";
import { sql } from "kysely";
import { describe, expect, test } from "vitest";

type HostDb = Parameters<typeof runMigrations>[0];
type Keys = Awaited<ReturnType<typeof resolvePluginEncryptionKeys>>;

const PLUGIN_ID = "otta";

/** Otta's four payment keys, by settings name, with sample values that must
 *  never appear in a raw row once encrypted. */
const SECRETS: Record<string, string> = {
	stripeSecretKey: "sk_test_RAW_ROW_NEVER_1",
	stripeWebhookSecret: "whsec_RAW_ROW_NEVER_2",
	"otta-wh-token": "edge_RAW_ROW_NEVER_3",
	x402FacilitatorApiKey: "x402_RAW_ROW_NEVER_4",
};

const SCHEMA = Object.fromEntries(
	Object.keys(SECRETS).map((name) => [name, { type: "secret" as const, label: name }]),
);

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh `EMDASH_ENCRYPTION_KEY` value, in the CLI's format. */
function generateKey(): string {
	return `emdash_enc_v1_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function keysFor(...raw: string[]): Promise<Keys> {
	return resolvePluginEncryptionKeys({ EMDASH_ENCRYPTION_KEY: raw.join(",") });
}

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code: unknown }).code
		: undefined;
}

/** Every raw `options` row this plugin owns, exactly as stored. */
async function rawRows(db: HostDb): Promise<Array<{ name: string; value: string }>> {
	const result = await sql<{ name: string; value: string }>`
		SELECT name, value FROM options WHERE name LIKE ${`plugin:${PLUGIN_ID}:%`} ORDER BY name
	`.execute(db);
	return result.rows;
}

export function pluginSecretSettingsCases(getDb: () => HostDb): void {
	const settings = (keys: Keys) =>
		createSettingsAccess(new OptionsRepository(getDb()), PLUGIN_ID, SCHEMA, keys);

	async function clear(): Promise<void> {
		await sql`DELETE FROM options WHERE name LIKE ${`plugin:${PLUGIN_ID}:%`}`.execute(getDb());
	}

	describe("EmDash secret plugin settings, on the raw options rows (ADR-0032)", () => {
		test("a declared secret is stored as an encrypted envelope; no raw row contains a value", async () => {
			await clear();
			const access = settings(await keysFor(generateKey()));
			for (const [name, value] of Object.entries(SECRETS)) await access.set(name, value);

			const rows = await rawRows(getDb());
			expect(rows).toHaveLength(Object.keys(SECRETS).length);
			const dump = JSON.stringify(rows);
			for (const value of Object.values(SECRETS)) expect(dump).not.toContain(value);
			for (const row of rows) expect(isEncryptedPluginSetting(JSON.parse(row.value))).toBe(true);
			for (const [name, value] of Object.entries(SECRETS)) {
				expect(await access.get(name)).toBe(value);
			}
		});

		test("a value stored before the declaration still reads, and one conditional re-save encrypts it in place", async () => {
			await clear();
			// What an earlier build left: the value itself, JSON-encoded in the row.
			const repo = new OptionsRepository(getDb());
			for (const [name, value] of Object.entries(SECRETS)) {
				await repo.set(`plugin:${PLUGIN_ID}:settings:${name}`, value);
			}
			expect(JSON.stringify(await rawRows(getDb()))).toContain(SECRETS["stripeSecretKey"]);

			const access = settings(await keysFor(generateKey()));
			for (const [name, value] of Object.entries(SECRETS)) {
				const current = await access.getVersioned<string>(name);
				expect(current?.value).toBe(value);
				const written = await access.compareAndSet(name, current?.revision ?? null, value);
				expect(written.applied).toBe(true);
				expect(await access.get(name)).toBe(value);
			}

			const rows = await rawRows(getDb());
			// Replaced in place: the same rows, no second copy left behind.
			expect(rows).toHaveLength(Object.keys(SECRETS).length);
			const dump = JSON.stringify(rows);
			for (const value of Object.values(SECRETS)) expect(dump).not.toContain(value);
		});

		test("a re-save at a stale revision is refused and leaves the newer value", async () => {
			await clear();
			const access = settings(await keysFor(generateKey()));
			await access.set("stripeSecretKey", "sk_test_OLD");
			const read = await access.getVersioned<string>("stripeSecretKey");
			await access.set("stripeSecretKey", "sk_test_NEW");
			const written = await access.compareAndSet(
				"stripeSecretKey",
				read?.revision ?? null,
				"sk_test_OLD",
			);
			expect(written.applied).toBe(false);
			expect(await access.get("stripeSecretKey")).toBe("sk_test_NEW");
		});

		test("with no encryption key the write is refused BEFORE it touches the row", async () => {
			await clear();
			const repo = new OptionsRepository(getDb());
			await repo.set(`plugin:${PLUGIN_ID}:settings:stripeSecretKey`, SECRETS["stripeSecretKey"]);
			const before = JSON.stringify(await rawRows(getDb()));

			const access = settings(null);
			const current = await access.getVersioned<string>("stripeSecretKey");
			const failure = await access
				.compareAndSet("stripeSecretKey", current?.revision ?? null, current?.value)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(errorCode(failure)).toBe("PLUGIN_SETTING_ENCRYPTION_KEY_MISSING");
			const plainSet = await access.set("stripeWebhookSecret", "whsec_x").then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(errorCode(plainSet)).toBe("PLUGIN_SETTING_ENCRYPTION_KEY_MISSING");
			expect(JSON.stringify(await rawRows(getDb()))).toBe(before);
		});

		test("an envelope does not open without its key, does not open with another, and opens after rotation", async () => {
			await clear();
			const original = generateKey();
			await settings(await keysFor(original)).set("stripeSecretKey", SECRETS["stripeSecretKey"]);

			const missing = await settings(null)
				.get("stripeSecretKey")
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(errorCode(missing)).toBe("PLUGIN_SETTING_ENCRYPTION_KEY_MISSING");

			const replaced = await settings(await keysFor(generateKey()))
				.get("stripeSecretKey")
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(errorCode(replaced)).toBe("PLUGIN_SETTING_ENCRYPTION_KEY_UNKNOWN");

			// Rotation: a new primary first, the old key still listed for reads.
			const rotated = settings(await keysFor(generateKey(), original));
			expect(await rotated.get("stripeSecretKey")).toBe(SECRETS["stripeSecretKey"]);
		});

		test("a setting NOT declared secret is stored as it always was", async () => {
			await clear();
			await settings(await keysFor(generateKey())).set("storeDisplayName", "Corner Shop");
			const rows = await rawRows(getDb());
			expect(rows).toEqual([
				{ name: `plugin:${PLUGIN_ID}:settings:storeDisplayName`, value: '"Corner Shop"' },
			]);
		});
	});
}
