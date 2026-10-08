/**
 * The one-time purge of the x402 settings earlier builds stored. A separate,
 * droppable change: see `payments/purge-legacy-x402-settings.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCronHandler, SWEEP_TASK_NAME } from "../src/cron/index.js";
import { EMAIL_LAST_SENT_KEY } from "../src/email/ctx-email-sender.js";
import {
	LEGACY_EMAIL_PURGE_MARKER_KEY,
	resetLegacyEmailPurgeForTesting,
} from "../src/email/purge-legacy-email-secrets.js";
import {
	PAYMENT_SECRET_KEYS,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
} from "../src/payment-secrets.js";
import {
	LEGACY_X402_PURGE_MARKER_KEY,
	LEGACY_X402_SETTING_KEYS,
	purgeLegacyX402Settings,
	resetLegacyX402PurgeForTesting,
} from "../src/payments/purge-legacy-x402-settings.js";
import type { KvAccess, PluginContext } from "../src/types.js";

function makeCtx(seed: Record<string, unknown>, failDeleteOf?: string) {
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
	};
	return { ctx, kv, calls };
}

const STORED = {
	"settings:x402PayTo": "0x1111111111111111111111111111111111111111",
	"settings:x402Accepts": "eip155:8453",
	"settings:x402FacilitatorApiKey": "fac_LIVE_KEY_0000000000",
	"settings:x402FacilitatorApiKeyGen": 3,
	"settings:x402FacilitatorSecret": "legacy_LIVE_SECRET_0000",
	"settings:x402FacilitatorSecretGen": 2,
	[STRIPE_SECRET_KEY_KEY]: "sk_test_keep",
	[STRIPE_WEBHOOK_SECRET_KEY]: "whsec_keep",
	[WEBHOOK_EDGE_TOKEN_KEY]: "edge_keep",
	"settings:emailFrom": "Keep <orders@shop.example>",
	"settings:storeDisplayName": "Keep",
};

beforeEach(() => {
	resetLegacyX402PurgeForTesting();
	resetLegacyEmailPurgeForTesting();
});
afterEach(() => vi.restoreAllMocks());

describe("purgeLegacyX402Settings", () => {
	test("deletes exactly the six x402 keys, and nothing else", async () => {
		const { ctx, kv } = makeCtx(STORED);
		expect(await purgeLegacyX402Settings(ctx)).toBe(true);
		for (const key of LEGACY_X402_SETTING_KEYS) expect(kv.has(key), key).toBe(false);
		for (const key of [
			STRIPE_SECRET_KEY_KEY,
			STRIPE_WEBHOOK_SECRET_KEY,
			WEBHOOK_EDGE_TOKEN_KEY,
			"settings:emailFrom",
			"settings:storeDisplayName",
		]) {
			expect(kv.has(key), key).toBe(true);
		}
		expect(typeof kv.get(LEGACY_X402_PURGE_MARKER_KEY)).toBe("string");
	});

	test("the keys purged are the exact strings earlier builds wrote", () => {
		expect([...LEGACY_X402_SETTING_KEYS]).toEqual([
			"settings:x402PayTo",
			"settings:x402Accepts",
			"settings:x402FacilitatorApiKey",
			"settings:x402FacilitatorApiKeyGen",
			"settings:x402FacilitatorSecret",
			"settings:x402FacilitatorSecretGen",
		]);
		// None is a key anything still provisions.
		for (const key of LEGACY_X402_SETTING_KEYS) {
			expect(PAYMENT_SECRET_KEYS as readonly string[]).not.toContain(key);
		}
	});

	test("a store that never had x402 settings is a safe no-op that still completes", async () => {
		const { ctx, kv } = makeCtx({ "settings:storeDisplayName": "Keep" });
		expect(await purgeLegacyX402Settings(ctx)).toBe(true);
		expect(kv.get("settings:storeDisplayName")).toBe("Keep");
		expect(typeof kv.get(LEGACY_X402_PURGE_MARKER_KEY)).toBe("string");
	});

	test("runs once: the marker stops a second isolate, and this isolate does not even read again", async () => {
		const first = makeCtx(STORED);
		await purgeLegacyX402Settings(first.ctx);
		first.calls.length = 0;
		expect(await purgeLegacyX402Settings(first.ctx)).toBe(false);
		expect(first.calls).toEqual([]);

		resetLegacyX402PurgeForTesting(); // a fresh isolate
		const restored = makeCtx({
			...STORED,
			[LEGACY_X402_PURGE_MARKER_KEY]: "2026-10-07T00:00:00Z",
		});
		expect(await purgeLegacyX402Settings(restored.ctx)).toBe(false);
		// The marker first, so a purged store pays one read per isolate.
		expect(restored.calls).toEqual([`get ${LEGACY_X402_PURGE_MARKER_KEY}`]);
		expect(restored.kv.has("settings:x402PayTo")).toBe(true);
	});

	test("a kv failure part way leaves the marker unset, never throws, and is retried", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const failing = makeCtx(STORED, "settings:x402FacilitatorApiKey");
		expect(await purgeLegacyX402Settings(failing.ctx)).toBe(false);
		expect(failing.kv.has(LEGACY_X402_PURGE_MARKER_KEY)).toBe(false);

		const healthy = makeCtx(Object.fromEntries(failing.kv));
		expect(await purgeLegacyX402Settings(healthy.ctx)).toBe(true);
		for (const key of LEGACY_X402_SETTING_KEYS) expect(healthy.kv.has(key), key).toBe(false);
	});

	test("a failing marker read never throws", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ctx, kv } = makeCtx(STORED);
		ctx.kv.get = async () => {
			throw new Error("kv down");
		};
		expect(await purgeLegacyX402Settings(ctx)).toBe(false);
		expect(kv.has("settings:x402PayTo")).toBe(true);
	});

	test("a host that answers `undefined` for a missing marker still purges", async () => {
		const { ctx, kv } = makeCtx(STORED);
		const get = ctx.kv.get.bind(ctx.kv);
		ctx.kv.get = async <T>(key: string) =>
			key === LEGACY_X402_PURGE_MARKER_KEY ? (undefined as T) : get<T>(key);
		expect(await purgeLegacyX402Settings(ctx)).toBe(true);
		expect(kv.has("settings:x402PayTo")).toBe(false);
	});

	test("never logs a value", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await purgeLegacyX402Settings(makeCtx(STORED, "settings:x402FacilitatorApiKey").ctx);
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/LIVE/);
	});

	test("the six deletes are issued together, before the marker is written", async () => {
		const { ctx, calls } = makeCtx(STORED);
		let inFlight = 0;
		let peak = 0;
		const del = ctx.kv.delete.bind(ctx.kv);
		ctx.kv.delete = async (key: string) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			inFlight -= 1;
			return del(key);
		};
		expect(await purgeLegacyX402Settings(ctx)).toBe(true);
		expect(peak).toBe(LEGACY_X402_SETTING_KEYS.length);
		expect(calls.at(-1)).toBe(`set ${LEGACY_X402_PURGE_MARKER_KEY}`);
	});

	test("never on the same tick as the email purge's deletes: it waits for the next tick", async () => {
		const { ctx, kv } = makeCtx({
			...STORED,
			"settings:emailApiKey": "re_LIVE_KEY_0000000000",
			// The host accepted a send, so the email purge does its deletes now.
			[EMAIL_LAST_SENT_KEY]: "2026-10-08T00:00:00.000Z",
		});
		const tick = async () => {
			try {
				// The sweep itself needs the document store this bare ctx lacks; the
				// purges run before it, which is all this case looks at.
				await createCronHandler()(
					{ name: SWEEP_TASK_NAME, scheduledAt: "" },
					{ ...ctx, email: { send: async () => {} } },
				);
			} catch {
				// expected: see above
			}
		};
		await tick();
		expect(typeof kv.get(LEGACY_EMAIL_PURGE_MARKER_KEY)).toBe("string");
		expect(kv.has("settings:x402PayTo")).toBe(true);
		expect(kv.has(LEGACY_X402_PURGE_MARKER_KEY)).toBe(false);

		await tick();
		for (const key of LEGACY_X402_SETTING_KEYS) expect(kv.has(key), key).toBe(false);
		expect(typeof kv.get(LEGACY_X402_PURGE_MARKER_KEY)).toBe("string");
	});

	test("an email purge that FAILED part way still counts as this tick's work: the x402 purge waits", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ctx, kv } = makeCtx(
			{
				...STORED,
				"settings:emailApiKey": "re_LIVE_KEY_0000000000",
				[EMAIL_LAST_SENT_KEY]: "2026-10-08T00:00:00.000Z",
			},
			"settings:emailApiKey",
		);
		try {
			await createCronHandler()(
				{ name: SWEEP_TASK_NAME, scheduledAt: "" },
				{ ...ctx, email: { send: async () => {} } },
			);
		} catch {
			// The sweep itself needs a document store this bare ctx lacks.
		}
		expect(kv.has(LEGACY_EMAIL_PURGE_MARKER_KEY)).toBe(false);
		expect(kv.has("settings:x402PayTo")).toBe(true);
		expect(kv.has(LEGACY_X402_PURGE_MARKER_KEY)).toBe(false);
	});

	test("the sweep tick runs it: a cron tick purges the stored keys, a foreign task does not", async () => {
		const foreign = makeCtx(STORED);
		await createCronHandler()({ name: "someone-else", scheduledAt: "" }, foreign.ctx);
		expect(foreign.kv.has("settings:x402PayTo")).toBe(true);

		const { ctx, kv } = makeCtx(STORED);
		// The sweep itself needs the document store this bare ctx lacks and rejects;
		// the purge runs before it, which is all this case looks at.
		try {
			await createCronHandler()({ name: SWEEP_TASK_NAME, scheduledAt: "" }, ctx);
		} catch {
			// expected: see above
		}
		for (const key of LEGACY_X402_SETTING_KEYS) expect(kv.has(key), key).toBe(false);
		expect(kv.get(STRIPE_SECRET_KEY_KEY)).toBe("sk_test_keep");
	});
});
