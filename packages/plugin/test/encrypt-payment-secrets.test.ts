/**
 * ADR-0037 — the one-time re-save of stored payment keys through EmDash's
 * encrypted settings path (`src/encrypt-payment-secrets.ts`).
 *
 * The kv here is a FAKE HOST that keeps a RAW row per key and behaves the way
 * EmDash 1.0.1's settings layer does for a field declared `secret`
 * (emdash `plugins/settings.ts`): a write stores an envelope, never the value, and
 * refuses before writing when there is no encryption key; a read returns a
 * plain string row as-is (a value stored before the declaration) and opens an
 * envelope only with the key. The REAL layer, over real sqlite, Postgres and D1
 * rows, is exercised in `sites/staging/test/payment-secrets-at-rest.test.ts` and
 * `packages/store-emdash/test/**plugin-secret-settings*`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	encryptStoredPaymentSecrets,
	PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY,
	PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE,
	PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY,
	resetPaymentSecretEncryptionForTesting,
} from "../src/encrypt-payment-secrets.js";
import {
	ENCRYPTED_PAYMENT_SECRET_KEYS,
	readWriteOnlySecret,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
} from "../src/payment-secrets.js";
import type { KvAccess, PluginContext } from "../src/types.js";

const VALUES: Record<string, string> = {
	[STRIPE_SECRET_KEY_KEY]: "sk_test_MIGRATE_NEVER_LOG_1",
	[STRIPE_WEBHOOK_SECRET_KEY]: "whsec_MIGRATE_NEVER_LOG_2",
	[WEBHOOK_EDGE_TOKEN_KEY]: "edge_MIGRATE_NEVER_LOG_3",
};

interface Envelope {
	$fake: "envelope";
	kid: string;
	sealed: string;
}

function isEnvelope(value: unknown): value is Envelope {
	return typeof value === "object" && value !== null && "$fake" in value;
}

function keyError(code: string): Error {
	return Object.assign(new Error("Plugin secret setting error"), {
		name: "PluginSettingEncryptionError",
		code,
	});
}

interface FakeHost {
	ctx: PluginContext;
	/** The raw rows, as the options table would hold them. */
	raw: Map<string, unknown>;
	/** The configured key ids: the first encrypts, all decrypt (EmDash's
	 *  comma-separated rotation list). Empty = no EMDASH_ENCRYPTION_KEY. */
	keys: { value: string[] };
	/** A sandboxed bridge's pre-1.0 copies, outside the options table. */
	legacy: Map<string, unknown>;
	/** Called before each compareAndSet; may throw to simulate a crash. */
	beforeCas: { fn: (key: string, calls: number) => void };
	casCalls: { n: number };
	/** A write that bypasses the declaration, as an earlier build (no
	 *  `settingsSchema`) does during a rollback: a plain row, new revision. */
	writePlain: (key: string, value: unknown) => void;
}

function fakeHost(seed: Record<string, unknown>, site = "https://shop.example"): FakeHost {
	const raw = new Map<string, unknown>(Object.entries(seed));
	const revisions = new Map<string, number>();
	const keys = { value: ["A"] };
	const legacy = new Map<string, unknown>();
	const beforeCas = { fn: (_key: string, _calls: number) => {} };
	const casCalls = { n: 0 };
	const secret = new Set<string>(ENCRYPTED_PAYMENT_SECRET_KEYS);
	const encode = (key: string, value: unknown): unknown => {
		if (!secret.has(key)) return value;
		const primary = keys.value[0];
		if (primary === undefined) throw keyError("PLUGIN_SETTING_ENCRYPTION_KEY_MISSING");
		return {
			$fake: "envelope",
			kid: primary,
			sealed: Buffer.from(String(value)).toString("base64"),
		};
	};
	const decode = (key: string, value: unknown): unknown => {
		if (!secret.has(key) || !isEnvelope(value)) return value;
		if (keys.value.length === 0) throw keyError("PLUGIN_SETTING_ENCRYPTION_KEY_MISSING");
		if (!keys.value.includes(value.kid)) throw keyError("PLUGIN_SETTING_ENCRYPTION_KEY_UNKNOWN");
		return Buffer.from(value.sealed, "base64").toString();
	};
	const bump = (key: string): string => {
		const next = (revisions.get(key) ?? 0) + 1;
		revisions.set(key, next);
		return String(next);
	};
	const kv: KvAccess = {
		async get<T>(key: string) {
			if (raw.has(key)) return decode(key, raw.get(key)) as T;
			return legacy.has(key) ? (legacy.get(key) as T) : null;
		},
		async set(key, value) {
			raw.set(key, encode(key, value));
			bump(key);
			legacy.delete(key);
		},
		async delete(key) {
			const a = raw.delete(key);
			const b = legacy.delete(key);
			return a || b;
		},
		async list() {
			return [];
		},
		async getVersioned<T>(key: string) {
			if (!raw.has(key)) {
				// The bridge falls back to the legacy copy, with ITS revision.
				return legacy.has(key) ? { value: legacy.get(key) as T, revision: `legacy-${key}` } : null;
			}
			return { value: decode(key, raw.get(key)) as T, revision: String(revisions.get(key) ?? 0) };
		},
		async compareAndSet(key, expectedRevision, value) {
			casCalls.n += 1;
			beforeCas.fn(key, casCalls.n);
			const encoded = encode(key, value);
			const current = raw.has(key) ? String(revisions.get(key) ?? 0) : null;
			if (current !== expectedRevision) return { applied: false };
			raw.set(key, encoded);
			// The sandbox bridge deletes its pre-1.0 copy once the write applies.
			legacy.delete(key);
			return { applied: true, revision: bump(key) };
		},
	};
	const ctx: PluginContext = {
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		kv,
		site: { name: "Shop", url: site, locale: "en" },
	};
	const writePlain = (key: string, value: unknown): void => {
		raw.set(key, value);
		bump(key);
	};
	return { ctx, raw, keys, legacy, beforeCas, casCalls, writePlain };
}

/** Every raw row, as one string — what a database export would show. */
function rawDump(host: FakeHost): string {
	return JSON.stringify([...host.raw]);
}

let logged: string[] = [];

beforeEach(() => {
	resetPaymentSecretEncryptionForTesting();
	logged = [];
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
		});
	}
});

/** Values the cases below store besides {@link VALUES}; never logged either. */
const OTHER_VALUES = ["sk_test_ENTERED_DURING_ROLLBACK"];

afterEach(() => {
	vi.restoreAllMocks();
	// Whatever a case did, nothing it logged may carry any value.
	for (const value of [...Object.values(VALUES), ...OTHER_VALUES]) {
		for (const line of logged) expect(line).not.toContain(value);
	}
});

describe("plain text → encrypted", () => {
	test("re-saves every stored key encrypted, reads each back, then marks the site done", async () => {
		const host = fakeHost({ ...VALUES });
		expect(rawDump(host)).toContain(VALUES[STRIPE_SECRET_KEY_KEY]);

		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");

		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(isEnvelope(host.raw.get(key)), key).toBe(true);
			// The readers see exactly what was stored before.
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
		for (const value of Object.values(VALUES)) expect(rawDump(host)).not.toContain(value);
		expect(host.raw.get(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY)).toMatchObject({
			set: PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE,
		});
	});

	test("keys that were never set stay unset, and the site is still marked done", async () => {
		const host = fakeHost({ [STRIPE_SECRET_KEY_KEY]: VALUES[STRIPE_SECRET_KEY_KEY] });
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(host.raw.has(STRIPE_WEBHOOK_SECRET_KEY)).toBe(false);
		expect(host.raw.has(WEBHOOK_EDGE_TOKEN_KEY)).toBe(false);
		expect(isEnvelope(host.raw.get(STRIPE_SECRET_KEY_KEY))).toBe(true);
		expect(host.casCalls.n).toBe(1);
	});

	test("touches no other key (the email keys and other settings are left alone)", async () => {
		const others = {
			"settings:emailApiKey": "re_OTHER",
			"settings:storeDisplayName": "Shop",
		};
		const host = fakeHost({ ...VALUES, ...others });
		await encryptStoredPaymentSecrets(host.ctx);
		for (const [key, value] of Object.entries(others)) expect(host.raw.get(key)).toBe(value);
	});

	test("leaves any x402 key alone, present or absent (its own purge deletes them)", async () => {
		const x402 = {
			"settings:x402FacilitatorApiKey": "x402_NEVER_LOG",
			"settings:x402FacilitatorSecret": "legacy_HMAC_NEVER_LOG",
		};
		const host = fakeHost({ ...VALUES, ...x402 });
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		for (const [key, value] of Object.entries(x402)) expect(host.raw.get(key)).toBe(value);
		expect(logged.join("\n")).not.toContain("NEVER_LOG");

		resetPaymentSecretEncryptionForTesting();
		const without = fakeHost({ ...VALUES });
		expect(await encryptStoredPaymentSecrets(without.ctx)).toBe("encrypted");
		for (const key of Object.keys(x402)) expect(without.raw.has(key)).toBe(false);
	});
});

describe("wrong key with mixed rows (preflight)", () => {
	test("one key already encrypted under A, the rest plain, key B configured: NOTHING is written", async () => {
		const host = fakeHost({ ...VALUES });
		// Key A encrypts the webhook secret; the others stay as an earlier build left them.
		await host.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, VALUES[STRIPE_WEBHOOK_SECRET_KEY]);
		host.keys.value = ["B"];
		const before = rawDump(host);

		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");
		expect(rawDump(host)).toBe(before);
		expect(host.casCalls.n).toBe(0);
		expect(host.raw.get(STRIPE_SECRET_KEY_KEY)).toBe(VALUES[STRIPE_SECRET_KEY_KEY]);
		expect(logged.join("\n")).toContain("EMDASH_ENCRYPTION_KEY");

		// The right key restored: the next tick finishes, and every key reads.
		resetPaymentSecretEncryptionForTesting();
		host.keys.value = ["A"];
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(isEnvelope(host.raw.get(key)), key).toBe(true);
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
	});

	test("rotation (new key first, old key listed) re-saves under the new key, losing nothing", async () => {
		const host = fakeHost({ ...VALUES });
		await host.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, VALUES[STRIPE_WEBHOOK_SECRET_KEY]);
		host.keys.value = ["B", "A"];
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		host.keys.value = ["B"];
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
	});
});

describe("a sandboxed pre-1.0 copy (outside the options table)", () => {
	test("is replaced by an encrypted row and its plain copy removed, counted not shown", async () => {
		const host = fakeHost({});
		host.legacy.set(STRIPE_SECRET_KEY_KEY, VALUES[STRIPE_SECRET_KEY_KEY]);
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(host.legacy.size).toBe(0);
		expect(isEnvelope(host.raw.get(STRIPE_SECRET_KEY_KEY))).toBe(true);
		expect(await readWriteOnlySecret(host.ctx, STRIPE_SECRET_KEY_KEY)).toBe(
			VALUES[STRIPE_SECRET_KEY_KEY],
		);
		expect(logged.join("\n")).toContain("1 legacy copies replaced");
	});
	test("an operator's save landing just before the replacement is never overwritten", async () => {
		const host = fakeHost({});
		host.legacy.set(STRIPE_SECRET_KEY_KEY, VALUES[STRIPE_SECRET_KEY_KEY]);
		const fresh = "sk_test_SAVED_DURING_FALLBACK";
		host.beforeCas.fn = (key, calls) => {
			// Call 1 is the conditional re-save (does not apply: no options row);
			// before call 2, the fallback, the operator saves a new key.
			if (calls === 2 && key === STRIPE_SECRET_KEY_KEY) void host.ctx.kv.set(key, fresh);
		};
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");
		expect(await readWriteOnlySecret(host.ctx, STRIPE_SECRET_KEY_KEY)).toBe(fresh);
	});
});

describe("progress across unfinished runs", () => {
	test("keys already re-saved are not re-saved again while a later key keeps failing", async () => {
		const host = fakeHost({ ...VALUES });
		host.beforeCas.fn = (key) => {
			if (key === ENCRYPTED_PAYMENT_SECRET_KEYS[1]) throw new Error("isolate evicted");
		};
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");
		expect(host.casCalls.n).toBe(2);
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");
		// Second run: only the failing key was attempted again.
		expect(host.casCalls.n).toBe(3);

		host.beforeCas.fn = () => {};
		// Last run: the failing key and the one after it; never the first again.
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(host.casCalls.n).toBe(5);
		expect(host.raw.has(PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY)).toBe(false);
	});
});

describe("idempotent", () => {
	test("a second call in the same isolate does nothing at all", async () => {
		const host = fakeHost({ ...VALUES });
		await encryptStoredPaymentSecrets(host.ctx);
		const after = rawDump(host);
		const calls = host.casCalls.n;
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("already-done");
		expect(host.casCalls.n).toBe(calls);
		expect(rawDump(host)).toBe(after);
	});

	test("a NEW isolate reads the marker and re-saves nothing", async () => {
		const host = fakeHost({ ...VALUES });
		await encryptStoredPaymentSecrets(host.ctx);
		const after = rawDump(host);
		const calls = host.casCalls.n;
		resetPaymentSecretEncryptionForTesting();
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("already-done");
		expect(host.casCalls.n).toBe(calls);
		expect(rawDump(host)).toBe(after);
	});

	test("a marker for a different key set runs again (a future key is not skipped)", async () => {
		const host = fakeHost({ ...VALUES, [PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY]: "v0:older" });
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(isEnvelope(host.raw.get(STRIPE_SECRET_KEY_KEY))).toBe(true);
	});

	test("values that are ALREADY encrypted are re-saved to the same value", async () => {
		const host = fakeHost({});
		for (const [key, value] of Object.entries(VALUES)) await host.ctx.kv.set(key, value);
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
	});

	test("each site keeps its own marker", async () => {
		const a = fakeHost({ ...VALUES }, "https://a.example");
		const b = fakeHost({ ...VALUES }, "https://b.example");
		expect(await encryptStoredPaymentSecrets(a.ctx)).toBe("encrypted");
		expect(await encryptStoredPaymentSecrets(b.ctx)).toBe("encrypted");
		expect(isEnvelope(b.raw.get(STRIPE_SECRET_KEY_KEY))).toBe(true);
	});
});

describe("a key written again after the marker (#478)", () => {
	test("plain text a rollback build saved is re-encrypted by the next isolate, and only that key", async () => {
		const host = fakeHost({ ...VALUES });
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		const fresh = "sk_test_ENTERED_DURING_ROLLBACK";
		host.writePlain(STRIPE_SECRET_KEY_KEY, fresh);
		expect(rawDump(host)).toContain(fresh);
		const calls = host.casCalls.n;

		resetPaymentSecretEncryptionForTesting();
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(host.casCalls.n).toBe(calls + 1);
		expect(isEnvelope(host.raw.get(STRIPE_SECRET_KEY_KEY))).toBe(true);
		expect(rawDump(host)).not.toContain(fresh);
		expect(await readWriteOnlySecret(host.ctx, STRIPE_SECRET_KEY_KEY)).toBe(fresh);
		expect(await readWriteOnlySecret(host.ctx, STRIPE_WEBHOOK_SECRET_KEY)).toBe(
			VALUES[STRIPE_WEBHOOK_SECRET_KEY],
		);

		// Settled again: the isolate after that rewrites nothing.
		resetPaymentSecretEncryptionForTesting();
		const after = rawDump(host);
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("already-done");
		expect(rawDump(host)).toBe(after);
	});

	test("a key stored for the first time after the marker is re-saved encrypted", async () => {
		const host = fakeHost({ [STRIPE_SECRET_KEY_KEY]: VALUES[STRIPE_SECRET_KEY_KEY] });
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		host.writePlain(WEBHOOK_EDGE_TOKEN_KEY, VALUES[WEBHOOK_EDGE_TOKEN_KEY]);

		resetPaymentSecretEncryptionForTesting();
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(isEnvelope(host.raw.get(WEBHOOK_EDGE_TOKEN_KEY))).toBe(true);
		expect(await readWriteOnlySecret(host.ctx, WEBHOOK_EDGE_TOKEN_KEY)).toBe(
			VALUES[WEBHOOK_EDGE_TOKEN_KEY],
		);
	});

	test("a key removed after the marker needs no write to it; the marker settles", async () => {
		const host = fakeHost({ ...VALUES });
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		await host.ctx.kv.delete(STRIPE_SECRET_KEY_KEY);
		const calls = host.casCalls.n;

		resetPaymentSecretEncryptionForTesting();
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(host.casCalls.n).toBe(calls);
		expect(host.raw.has(STRIPE_SECRET_KEY_KEY)).toBe(false);

		resetPaymentSecretEncryptionForTesting();
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("already-done");
	});

	test("a site an earlier build marked done (v1 marker) re-saves once, then settles", async () => {
		const host = fakeHost({
			...VALUES,
			[PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY]: `v1:${ENCRYPTED_PAYMENT_SECRET_KEYS.join(",")}`,
		});
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(isEnvelope(host.raw.get(key)), key).toBe(true);
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
		resetPaymentSecretEncryptionForTesting();
		const calls = host.casCalls.n;
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("already-done");
		expect(host.casCalls.n).toBe(calls);
	});

	test("a save between the write and the read-back is kept, and the run retries (even the same value)", async () => {
		const host = fakeHost({ ...VALUES });
		// The SAME value: only the read-back's revision check can tell this save
		// (a plain one, as a rollback build writes it) from the re-save's own.
		const fresh = VALUES[STRIPE_SECRET_KEY_KEY];
		const { compareAndSet } = host.ctx.kv;
		if (compareAndSet === undefined) throw new Error("fake has compareAndSet");
		const kv: KvAccess = {
			...host.ctx.kv,
			async compareAndSet(key, expected, value) {
				const result = await compareAndSet(key, expected, value);
				if (key === STRIPE_SECRET_KEY_KEY) host.writePlain(key, fresh);
				return result;
			},
		};
		expect(await encryptStoredPaymentSecrets({ ...host.ctx, kv })).toBe("retry");
		expect(await readWriteOnlySecret(host.ctx, STRIPE_SECRET_KEY_KEY)).toBe(fresh);
		// Not recorded as encrypted: the next isolate re-saves it.
		expect(host.raw.has(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY)).toBe(false);
		resetPaymentSecretEncryptionForTesting();
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(isEnvelope(host.raw.get(STRIPE_SECRET_KEY_KEY))).toBe(true);
	});
});

describe("a settled site whose key cannot be read (#478)", () => {
	test("is checked once per isolate, logs once, and never says the keys are unencrypted", async () => {
		const host = fakeHost({ ...VALUES });
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		resetPaymentSecretEncryptionForTesting();
		logged = [];
		host.keys.value = ["B"];
		let reads = 0;
		const { getVersioned } = host.ctx.kv;
		if (getVersioned === undefined) throw new Error("fake has getVersioned");
		const kv: KvAccess = {
			...host.ctx.kv,
			async getVersioned<T>(key: string) {
				reads += 1;
				return getVersioned<T>(key);
			},
		};
		const ctx: PluginContext = { ...host.ctx, kv };
		const before = rawDump(host);

		expect(await encryptStoredPaymentSecrets(ctx)).toBe("retry");
		const afterFirst = reads;
		expect(await encryptStoredPaymentSecrets(ctx)).toBe("already-done");
		expect(reads).toBe(afterFirst);
		expect(rawDump(host)).toBe(before);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("EMDASH_ENCRYPTION_KEY");
		expect(logged[0]).not.toContain("not encrypted yet");
	});
});

describe("interrupted part way", () => {
	test("a crash after the first key loses nothing, and the next tick finishes", async () => {
		const host = fakeHost({ ...VALUES });
		host.beforeCas.fn = (_key, calls) => {
			if (calls === 2) throw new Error("isolate evicted");
		};
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");

		// Every key still reads as what was stored: one encrypted, the rest as before.
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
		expect(isEnvelope(host.raw.get(ENCRYPTED_PAYMENT_SECRET_KEYS[0]))).toBe(true);
		expect(host.raw.get(ENCRYPTED_PAYMENT_SECRET_KEYS[1])).toBe(
			VALUES[ENCRYPTED_PAYMENT_SECRET_KEYS[1]],
		);
		// The marker records only the key that was finished.
		expect(host.raw.get(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY)).toEqual({
			set: PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE,
			revisions: { [ENCRYPTED_PAYMENT_SECRET_KEYS[0]]: expect.any(String) },
		});

		host.beforeCas.fn = () => {};
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(isEnvelope(host.raw.get(key)), key).toBe(true);
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
	});

	test("an operator's save between the read and the write is never overwritten", async () => {
		const host = fakeHost({ ...VALUES });
		const fresh = "sk_test_SAVED_MEANWHILE";
		host.beforeCas.fn = (key, calls) => {
			// The operator saves a new Stripe key through the Settings form (an
			// ordinary encrypted set) after the migration read the old one.
			// (The fake's `set` completes synchronously, before the write below.)
			if (calls === 1 && key === STRIPE_SECRET_KEY_KEY) void host.ctx.kv.set(key, fresh);
		};
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");
		expect(await readWriteOnlySecret(host.ctx, STRIPE_SECRET_KEY_KEY)).toBe(fresh);

		host.beforeCas.fn = () => {};
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		expect(await readWriteOnlySecret(host.ctx, STRIPE_SECRET_KEY_KEY)).toBe(fresh);
	});
});

describe("no encryption key", () => {
	test("nothing is written, every key still reads, and the warning names the setting once", async () => {
		const host = fakeHost({ ...VALUES });
		host.keys.value = [];
		const before = rawDump(host);

		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("retry");

		expect(rawDump(host)).toBe(before);
		expect(host.raw.has(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY)).toBe(false);
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			expect(await readWriteOnlySecret(host.ctx, key)).toBe(VALUES[key]);
		}
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("EMDASH_ENCRYPTION_KEY");

		// Once the key is configured, the next tick finishes.
		host.keys.value = ["A"];
		expect(await encryptStoredPaymentSecrets(host.ctx)).toBe("encrypted");
		for (const value of Object.values(VALUES)) expect(rawDump(host)).not.toContain(value);
	});

	test("a host whose kv has no conditional write is left exactly as it was", async () => {
		const host = fakeHost({ ...VALUES });
		const { getVersioned: _g, compareAndSet: _c, ...plain } = host.ctx.kv;
		const ctx: PluginContext = { ...host.ctx, kv: plain };
		const before = rawDump(host);
		expect(await encryptStoredPaymentSecrets(ctx)).toBe("retry");
		expect(rawDump(host)).toBe(before);
	});

	test("a kv that fails outright is a retry, never a throw", async () => {
		const host = fakeHost({ ...VALUES });
		const ctx: PluginContext = {
			...host.ctx,
			kv: { ...host.ctx.kv, get: () => Promise.reject(new Error("kv down")) },
		};
		await expect(encryptStoredPaymentSecrets(ctx)).resolves.toBe("retry");
	});
});
