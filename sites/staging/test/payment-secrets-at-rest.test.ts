/**
 * ADR-0032, end to end over a REAL host layer: Otta's own write path (the
 * Settings form), read path (`readPaymentSecrets`) and one-time migration
 * (`encryptStoredPaymentSecrets`), running on EmDash 1.0.1's settings layer with
 * the `settingsSchema` THIS SITE's descriptor declares, over a migrated SQLite
 * database — asserting the raw `options` rows.
 *
 * The kv below is EmDash's routing, restated: `createKVAccess`
 * (emdash `plugins/context.ts:134-176`) sends `settings:*` keys to the settings
 * access and every other key to `plugin:<id>:<key>` in the options table. It is
 * not a public export, so it is mirrored here; `createSettingsAccess`,
 * `OptionsRepository` and the encryption are the host's own code.
 */
import {
	COMMERCE_STORAGE_COLLECTIONS,
	createSettingsFormHandler,
	encryptStoredPaymentSecrets,
	ENCRYPTED_PAYMENT_SECRET_KEYS,
	OTTA_PLUGIN_ID,
	PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY,
	readPaymentSecrets,
	readSecret,
	resetPaymentSecretEncryptionForTesting,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
	X402_FACILITATOR_API_KEY_KEY,
	X402_LEGACY_FACILITATOR_SECRET_KEY,
	type PluginContext,
} from "@otta-sh/plugin";
import Database from "better-sqlite3";
import {
	createSettingsAccess,
	isEncryptedPluginSetting,
	OptionsRepository,
	resolvePluginEncryptionKeys,
} from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, sql, SqliteDialect } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ottaPluginDescriptor } from "../src/otta-plugin-descriptor.js";

type HostDb = Parameters<typeof runMigrations>[0];
type Keys = Awaited<ReturnType<typeof resolvePluginEncryptionKeys>>;

const SCHEMA = ottaPluginDescriptor().settingsSchema ?? {};

/** Values in the shapes the Settings form accepts. */
const VALUES: Record<string, string> = {
	[STRIPE_SECRET_KEY_KEY]: "sk_test_ATREST_NEVER_IN_A_ROW",
	[STRIPE_WEBHOOK_SECRET_KEY]: "whsec_ATREST_NEVER_IN_A_ROW",
	[WEBHOOK_EDGE_TOKEN_KEY]: "edge_ATREST_NEVER_IN_A_ROW",
	[X402_FACILITATOR_API_KEY_KEY]: "x402_ATREST_NEVER_IN_A_ROW",
};

/** The Settings form's action and field for each key. */
const FORM: Record<string, { action: string; field: string }> = {
	[STRIPE_SECRET_KEY_KEY]: { action: "save-stripe-secret-key", field: "stripeSecretKey" },
	[STRIPE_WEBHOOK_SECRET_KEY]: {
		action: "save-stripe-webhook-secret",
		field: "stripeWebhookSecret",
	},
	[WEBHOOK_EDGE_TOKEN_KEY]: { action: "save-webhook-edge-token", field: "webhookEdgeToken" },
	[X402_FACILITATOR_API_KEY_KEY]: {
		action: "save-x402-facilitator-secret",
		field: "x402FacilitatorSecret",
	},
};

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function generateKey(): string {
	return `emdash_enc_v1_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

let db: HostDb;
let keyA: Keys;

beforeAll(async () => {
	db = new Kysely({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
	}) as HostDb;
	await runMigrations(db);
	keyA = await resolvePluginEncryptionKeys({ EMDASH_ENCRYPTION_KEY: generateKey() });
});

afterAll(async () => {
	await db.destroy();
});

beforeEach(async () => {
	resetPaymentSecretEncryptionForTesting();
	await sql`DELETE FROM options WHERE name LIKE ${`plugin:${OTTA_PLUGIN_ID}:%`}`.execute(db);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** The settings name a `settings:*` kv key routes to, else `undefined`. */
function name(key: string): string | undefined {
	return key.startsWith("settings:") ? key.slice("settings:".length) : undefined;
}

/** The options-table name of a non-settings kv key. */
function plain(key: string): string {
	return `plugin:${OTTA_PLUGIN_ID}:${key}`;
}

/** The kv a trusted plugin gets from EmDash 1.0.1, over this database. */
function hostCtx(keys: Keys): PluginContext {
	const repo = new OptionsRepository(db);
	const settings = createSettingsAccess(repo, OTTA_PLUGIN_ID, SCHEMA, keys);
	const unused = new Proxy(
		{},
		{
			get: () => () => {
				throw new Error("this suite never reads commerce storage");
			},
		},
	);
	return {
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		storage: Object.fromEntries(
			Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((collection) => [collection, unused]),
		) as PluginContext["storage"],
		site: { name: "Shop", url: "https://shop.example", locale: "en" },
		kv: {
			get: <T>(key: string) => {
				const n = name(key);
				return n === undefined ? repo.get<T>(plain(key)) : settings.get<T>(n);
			},
			set: async (key, value) => {
				const n = name(key);
				await (n === undefined ? repo.set(plain(key), value) : settings.set(n, value));
			},
			delete: (key) => {
				const n = name(key);
				return n === undefined ? repo.delete(plain(key)) : settings.delete(n);
			},
			list: async () => [],
			getVersioned: <T>(key: string) => {
				const n = name(key);
				return n === undefined ? repo.getVersioned<T>(plain(key)) : settings.getVersioned<T>(n);
			},
			compareAndSet: (key, expectedRevision, value) => {
				const n = name(key);
				return n === undefined
					? repo.compareAndSet(plain(key), expectedRevision, value)
					: settings.compareAndSet(n, expectedRevision, value);
			},
		},
	};
}

async function rawDump(): Promise<string> {
	const rows = await sql<{ name: string; value: string }>`
		SELECT name, value FROM options WHERE name LIKE ${`plugin:${OTTA_PLUGIN_ID}:%`}
	`.execute(db);
	return JSON.stringify(rows.rows);
}

async function rawValue(key: string): Promise<unknown> {
	const row = await sql<{ value: string }>`
		SELECT value FROM options WHERE name = ${`plugin:${OTTA_PLUGIN_ID}:${key}`}
	`.execute(db);
	const value = row.rows[0]?.value;
	return value === undefined ? undefined : JSON.parse(value);
}

describe("payment keys at rest, through this site's descriptor (ADR-0032)", () => {
	test("the Settings form saves every payment key as ciphertext; the readers get the value", async () => {
		const ctx = hostCtx(keyA);
		const handler = createSettingsFormHandler();
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			const form = FORM[key];
			if (form === undefined) throw new Error(`no form for ${key}`);
			await handler(
				{
					input: { action_id: form.action, values: { [form.field]: VALUES[key] } },
					request: { method: "POST", url: "/route", headers: {} },
				},
				ctx,
			);
		}

		const dump = await rawDump();
		for (const value of Object.values(VALUES)) expect(dump).not.toContain(value);
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(isEncryptedPluginSetting(await rawValue(key)), key).toBe(true);
		}
		expect(await readPaymentSecrets(ctx)).toMatchObject({
			stripeSecretKey: VALUES[STRIPE_SECRET_KEY_KEY],
			stripeWebhookSecret: VALUES[STRIPE_WEBHOOK_SECRET_KEY],
			webhookEdgeToken: VALUES[WEBHOOK_EDGE_TOKEN_KEY],
			x402FacilitatorSecret: VALUES[X402_FACILITATOR_API_KEY_KEY],
		});
	});

	test("a site upgraded with plain-text keys is migrated once, losing nothing", async () => {
		// What an earlier build left in the options table: the values themselves.
		const repo = new OptionsRepository(db);
		for (const [key, value] of Object.entries(VALUES)) {
			await repo.set(`plugin:${OTTA_PLUGIN_ID}:${key}`, value);
		}
		expect(await rawDump()).toContain(VALUES[STRIPE_SECRET_KEY_KEY]);

		const ctx = hostCtx(keyA);
		// Before the migration the readers already work (the host reads old rows).
		expect((await readPaymentSecrets(ctx)).stripeSecretKey).toBe(VALUES[STRIPE_SECRET_KEY_KEY]);

		expect(await encryptStoredPaymentSecrets(ctx)).toBe("encrypted");
		const dump = await rawDump();
		for (const value of Object.values(VALUES)) expect(dump).not.toContain(value);
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(isEncryptedPluginSetting(await rawValue(key)), key).toBe(true);
			expect(await readSecret(ctx, key)).toEqual({ state: "set", value: VALUES[key] });
		}
		expect(await rawValue(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY)).toEqual(expect.any(String));

		// A later isolate finds the marker and rewrites nothing.
		resetPaymentSecretEncryptionForTesting();
		expect(await encryptStoredPaymentSecrets(ctx)).toBe("already-done");
		expect(await rawDump()).toBe(dump);
	});

	test("without EMDASH_ENCRYPTION_KEY the migration writes nothing and plain-text keys keep working", async () => {
		const repo = new OptionsRepository(db);
		await repo.set(
			`plugin:${OTTA_PLUGIN_ID}:${STRIPE_SECRET_KEY_KEY}`,
			VALUES[STRIPE_SECRET_KEY_KEY],
		);
		const before = await rawDump();

		const ctx = hostCtx(null);
		expect(await encryptStoredPaymentSecrets(ctx)).toBe("retry");
		expect(await rawDump()).toBe(before);
		expect((await readPaymentSecrets(ctx)).stripeSecretKey).toBe(VALUES[STRIPE_SECRET_KEY_KEY]);
	});

	test("an encrypted key with the key missing or replaced is UNREADABLE: payments refuse, the page says so", async () => {
		const saved = hostCtx(keyA);
		for (const [key, value] of Object.entries(VALUES)) await saved.kv.set(key, value);

		const other = await resolvePluginEncryptionKeys({ EMDASH_ENCRYPTION_KEY: generateKey() });
		for (const keys of [null, other]) {
			const ctx = hostCtx(keys);
			const secrets = await readPaymentSecrets(ctx);
			expect(secrets.stripeSecretKey).toBeUndefined();
			expect(secrets.stripeWebhookSecret).toBeUndefined();
			expect(secrets.webhookEdgeToken).toBeUndefined();
			for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
				expect(await readSecret(ctx, key)).toEqual({ state: "unreadable" });
			}
			const page = await createSettingsFormHandler()(
				{ input: { type: "page_load" }, request: { method: "POST", url: "/route", headers: {} } },
				ctx,
			);
			const whole = JSON.stringify(page);
			expect(whole).toContain("Stripe secret key — saved, but cannot be read");
			for (const value of Object.values(VALUES)) expect(whole).not.toContain(value);
		}

		// Rotation: the old key listed after a new primary still opens them.
		const rotated = await resolvePluginEncryptionKeys({
			EMDASH_ENCRYPTION_KEY: [generateKey(), keyA?.[0]?.raw ?? ""].join(","),
		});
		expect((await readPaymentSecrets(hostCtx(rotated))).stripeSecretKey).toBe(
			VALUES[STRIPE_SECRET_KEY_KEY],
		);
	});

	test("a WRONG key with mixed rows changes nothing; the right key then finishes and purges the retired x402 secret", async () => {
		const repo = new OptionsRepository(db);
		// An earlier build's plain rows, the webhook secret already encrypted under
		// key A, and the retired x402 secret.
		for (const [key, value] of Object.entries(VALUES)) {
			await repo.set(`plugin:${OTTA_PLUGIN_ID}:${key}`, value);
		}
		await hostCtx(keyA).kv.set(STRIPE_WEBHOOK_SECRET_KEY, VALUES[STRIPE_WEBHOOK_SECRET_KEY]);
		await repo.set(
			`plugin:${OTTA_PLUGIN_ID}:${X402_LEGACY_FACILITATOR_SECRET_KEY}`,
			"retired_hmac",
		);
		const before = await rawDump();

		const wrong = await resolvePluginEncryptionKeys({ EMDASH_ENCRYPTION_KEY: generateKey() });
		expect(await encryptStoredPaymentSecrets(hostCtx(wrong))).toBe("retry");
		expect(await rawDump()).toBe(before);

		resetPaymentSecretEncryptionForTesting();
		const ctx = hostCtx(keyA);
		expect(await encryptStoredPaymentSecrets(ctx)).toBe("encrypted");
		const dump = await rawDump();
		for (const value of Object.values(VALUES)) expect(dump).not.toContain(value);
		expect(dump).not.toContain("retired_hmac");
		expect(await rawValue(X402_LEGACY_FACILITATOR_SECRET_KEY)).toBeUndefined();
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(await readSecret(ctx, key)).toEqual({ state: "set", value: VALUES[key] });
		}
	});

	test("a malformed value saved outside Otta's form (EmDash's own settings) is refused on read", async () => {
		const ctx = hostCtx(keyA);
		await ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, "");
		await ctx.kv.set(STRIPE_SECRET_KEY_KEY, "not-a-stripe-key");
		expect(isEncryptedPluginSetting(await rawValue(WEBHOOK_EDGE_TOKEN_KEY))).toBe(true);
		expect(await readSecret(ctx, WEBHOOK_EDGE_TOKEN_KEY)).toEqual({ state: "invalid" });
		expect(await readSecret(ctx, STRIPE_SECRET_KEY_KEY)).toEqual({ state: "invalid" });
		expect((await readPaymentSecrets(ctx)).stripeSecretKey).toBeUndefined();
	});
});
