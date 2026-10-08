/**
 * The one-time purge of the email credentials earlier builds stored (ADR-0031).
 * A separate, droppable change: see `purge-legacy-email-secrets.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	EMAIL_LAST_SENT_KEY,
	EMAIL_TRANSPORT_UNAVAILABLE_KEY,
} from "../src/email/ctx-email-sender.js";
import {
	LEGACY_EMAIL_PURGE_MARKER_KEY,
	LEGACY_EMAIL_SECRET_KEYS,
	purgeLegacyEmailSecrets,
	resetLegacyEmailPurgeForTesting,
} from "../src/email/purge-legacy-email-secrets.js";
import {
	PAYMENT_SECRET_KEYS,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
	X402_FACILITATOR_API_KEY_KEY,
} from "../src/payment-secrets.js";
import type { KvAccess, PluginContext } from "../src/types.js";

function makeCtx(
	seed: Record<string, unknown>,
	failDeleteOf?: string,
	{ email = true }: { email?: boolean } = {},
) {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const calls: string[] = [];
	const access: KvAccess = {
		async get<T>(key: string): Promise<T | null> {
			calls.push(`get ${key}`);
			return kv.has(key) ? (kv.get(key) as T) : null;
		},
		async set(key: string, value: unknown) {
			calls.push(`set ${key}`);
			kv.set(key, value);
		},
		async delete(key: string) {
			calls.push(`delete ${key}`);
			if (key === failDeleteOf) throw new Error("kv down");
			return kv.delete(key);
		},
		async list() {
			return [];
		},
	};
	const ctx: PluginContext = {
		http: { fetch: () => Promise.reject(new Error("no egress")) },
		kv: access,
		...(email ? { email: { send: async () => {} } } : {}),
	};
	return { ctx, kv, calls };
}

const STORED = {
	"settings:emailApiKey": "re_LIVE_KEY_0000000000",
	"settings:emailApiKeyGen": 3,
	"settings:emailSmtp2goApiKey": "api-LIVEKEY00000000",
	"settings:emailSmtp2goApiKeyGen": 1,
	[STRIPE_SECRET_KEY_KEY]: "sk_test_keep",
	[STRIPE_WEBHOOK_SECRET_KEY]: "whsec_keep",
	[X402_FACILITATOR_API_KEY_KEY]: "fac_keep",
	[WEBHOOK_EDGE_TOKEN_KEY]: "edge_keep",
	"settings:storeDisplayName": "Keep",
	// The host has accepted a send: a provider is confirmed working.
	[EMAIL_LAST_SENT_KEY]: "2026-10-08T00:00:00.000Z",
};

/** The same store, before any send has gone through the host's provider. */
const { [EMAIL_LAST_SENT_KEY]: _sent, ...UNCONFIRMED } = STORED;

beforeEach(() => resetLegacyEmailPurgeForTesting());
afterEach(() => vi.restoreAllMocks());

describe("purgeLegacyEmailSecrets", () => {
	test("deletes exactly the two email keys and their save generations, and nothing else", async () => {
		const { ctx, kv } = makeCtx(STORED);
		expect(await purgeLegacyEmailSecrets(ctx)).toBe(true);
		for (const key of LEGACY_EMAIL_SECRET_KEYS) expect(kv.has(key), key).toBe(false);
		for (const key of [...PAYMENT_SECRET_KEYS, "settings:storeDisplayName"]) {
			expect(kv.has(key), key).toBe(true);
		}
		expect(typeof kv.get(LEGACY_EMAIL_PURGE_MARKER_KEY)).toBe("string");
		// None of the purged keys is a key anything still provisions.
		for (const key of LEGACY_EMAIL_SECRET_KEYS) {
			expect(PAYMENT_SECRET_KEYS as readonly string[]).not.toContain(key);
		}
	});

	test("runs once: the marker stops a second isolate, and this isolate does not even read again", async () => {
		const first = makeCtx(STORED);
		await purgeLegacyEmailSecrets(first.ctx);
		first.calls.length = 0;
		expect(await purgeLegacyEmailSecrets(first.ctx)).toBe(false);
		expect(first.calls).toEqual([]);

		resetLegacyEmailPurgeForTesting(); // a fresh isolate
		const restored = makeCtx({
			...STORED,
			[LEGACY_EMAIL_PURGE_MARKER_KEY]: "2026-10-07T00:00:00Z",
		});
		expect(await purgeLegacyEmailSecrets(restored.ctx)).toBe(false);
		expect(restored.calls).toEqual([
			`get ${EMAIL_TRANSPORT_UNAVAILABLE_KEY}`,
			`get ${EMAIL_LAST_SENT_KEY}`,
			`get ${LEGACY_EMAIL_PURGE_MARKER_KEY}`,
		]);
		expect(restored.kv.has("settings:emailApiKey")).toBe(true);
	});

	test("a kv failure part way leaves the marker unset, never throws, and is retried", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const failing = makeCtx(STORED, "settings:emailSmtp2goApiKey");
		expect(await purgeLegacyEmailSecrets(failing.ctx)).toBe(false);
		expect(failing.kv.has(LEGACY_EMAIL_PURGE_MARKER_KEY)).toBe(false);

		const healthy = makeCtx(Object.fromEntries(failing.kv));
		expect(await purgeLegacyEmailSecrets(healthy.ctx)).toBe(true);
		for (const key of LEGACY_EMAIL_SECRET_KEYS) expect(healthy.kv.has(key), key).toBe(false);
	});

	test("per site: a second site served by the same isolate is purged too (security review F3)", async () => {
		const a = makeCtx(STORED);
		const b = makeCtx(STORED);
		expect(
			await purgeLegacyEmailSecrets({
				...a.ctx,
				site: { name: "A", url: "https://a.example", locale: "en" },
			}),
		).toBe(true);
		expect(
			await purgeLegacyEmailSecrets({
				...b.ctx,
				site: { name: "B", url: "https://b.example", locale: "en" },
			}),
		).toBe(true);
		for (const key of LEGACY_EMAIL_SECRET_KEYS) expect(b.kv.has(key), key).toBe(false);
	});

	test("a host that answers `undefined` for a missing marker still purges", async () => {
		const { ctx, kv } = makeCtx(STORED);
		const get = ctx.kv.get.bind(ctx.kv);
		ctx.kv.get = async <T>(key: string) =>
			key === LEGACY_EMAIL_PURGE_MARKER_KEY ? (undefined as T) : get<T>(key);
		expect(await purgeLegacyEmailSecrets(ctx)).toBe(true);
		expect(kv.has("settings:emailApiKey")).toBe(false);
	});

	describe("PR #418 review: only once a host email provider has delivered (rollback stays possible)", () => {
		test("no `ctx.email` (trusted, no provider selected) ⇒ keys kept, not even a kv read", async () => {
			const { ctx, kv, calls } = makeCtx(STORED, undefined, { email: false });
			expect(await purgeLegacyEmailSecrets(ctx)).toBe(false);
			expect(calls).toEqual([]);
			for (const key of LEGACY_EMAIL_SECRET_KEYS) expect(kv.has(key), key).toBe(true);
			expect(kv.has(LEGACY_EMAIL_PURGE_MARKER_KEY)).toBe(false);
		});

		test("`ctx.email` there but no send confirmed yet (a sandboxed host with no provider looks like this) ⇒ keys kept, retried next tick", async () => {
			const { ctx, kv } = makeCtx(UNCONFIRMED);
			expect(await purgeLegacyEmailSecrets(ctx)).toBe(false);
			expect(await purgeLegacyEmailSecrets(ctx)).toBe(false);
			for (const key of LEGACY_EMAIL_SECRET_KEYS) expect(kv.has(key), key).toBe(true);
			expect(kv.has(LEGACY_EMAIL_PURGE_MARKER_KEY)).toBe(false);

			// The first send goes through the host's provider: the next tick purges.
			kv.set(EMAIL_LAST_SENT_KEY, new Date().toISOString());
			expect(await purgeLegacyEmailSecrets(ctx)).toBe(true);
			for (const key of LEGACY_EMAIL_SECRET_KEYS) expect(kv.has(key), key).toBe(false);
		});

		test("a 'no provider' answer NEWER than the last send ⇒ not confirmed, keys kept", async () => {
			const { ctx, kv } = makeCtx({
				...STORED,
				[EMAIL_LAST_SENT_KEY]: "2026-10-01T00:00:00.000Z",
				[EMAIL_TRANSPORT_UNAVAILABLE_KEY]: "2026-10-02T00:00:00.000Z",
			});
			expect(await purgeLegacyEmailSecrets(ctx)).toBe(false);
			expect(kv.has("settings:emailApiKey")).toBe(true);
		});

		test("an unreadable status record ⇒ not confirmed, keys kept, never throws", async () => {
			const { ctx, kv } = makeCtx(STORED);
			const get = ctx.kv.get.bind(ctx.kv);
			ctx.kv.get = async <T>(key: string) => {
				if (key === EMAIL_LAST_SENT_KEY) throw new Error("kv down");
				return get<T>(key);
			};
			expect(await purgeLegacyEmailSecrets(ctx)).toBe(false);
			expect(kv.has("settings:emailApiKey")).toBe(true);
		});
	});

	test("never logs a value", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await purgeLegacyEmailSecrets(makeCtx(STORED, "settings:emailApiKey").ctx);
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/LIVE/);
	});
});
