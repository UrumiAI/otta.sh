/**
 * ADR-0047 route races, over SQLite with an injectable step between two storage
 * calls: what a sandbox run cannot pin deterministically.
 *  - the cart key carries the body's fingerprint (two bodies under one key never
 *    share a cart);
 *  - a create the domain refuses AFTER its cart was built (a racer took the key
 *    with another body) releases that cart's holds;
 *  - cancel decides whether to release the agent's cart on the session the cancel
 *    LEFT, so a redeem landing between its first read and its write keeps the
 *    shopper's cart whole;
 *  - which carts count as still held (a digital line does; a lapsed hold does not).
 */
import {
	createAgentSession,
	currency,
	redeemAgentHandoff,
	type AgentSessionDeps,
} from "@urumi.ai/otta-domain";
import {
	AGENT_SESSIONS_COLLECTION,
	AGENT_SESSION_CREATE_KEYS_COLLECTION,
	EmdashAgentSessionStore,
	randomBase64Url,
	systemClock,
	WebCryptoAgentSessionSecrets,
	base64UrlDecode,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	acceptedSelection,
	agentCartKey,
	allHeld,
	createAgenticHandoffRedeemHandler,
	createAgenticSessionCancelHandler,
	createAgenticSessionCreateHandler,
	createAgenticSessionUpdateHandler,
} from "../src/agentic/routes.js";
import { fingerprintOf, parseAgentSessionInput } from "../src/agentic/input.js";
import { AGENTIC_ENABLED_KEY, AGENTIC_SERVER_KEY_KEY } from "../src/agentic/settings.js";
import { makeCommerceClient } from "../src/commerce/make-commerce-client.js";
import type { PluginContext } from "../src/types.js";
import { sweepContext } from "./cron-sweep-fixtures.js";
import {
	AGENT_ADDRESS,
	agenticFixture,
	cartLines,
	seedAgenticStore,
	seedProduct,
} from "./helpers/agentic-sandbox.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const F = agenticFixture("aru");
const [MUG] = F.products;
/** One unit on hand. */
const LAST = { id: "prod-aru-last", sku: "SKU-ARU-LAST", amount: 4000 };
const SERVER_KEY = randomBase64Url(32);
const REQUEST = {
	method: "POST",
	url: "https://shop.test/",
	headers: { "cf-connecting-ip": "198.51.100.40" },
};

let base: StorageAccess;
/** Run (once, uncounted) before the named collection call; cleared by the test. */
let before: ((collection: string, method: string) => Promise<void>) | null = null;

/** `base`, with {@link before} run ahead of every collection call. */
function hooked(): StorageAccess {
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(base)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return async (...args: unknown[]) => {
					if (before !== null) await before(name, String(prop));
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return wrapped;
}

function ctx(): PluginContext {
	return sweepContext(hooked(), undefined, {
		[AGENTIC_ENABLED_KEY]: true,
		[AGENTIC_SERVER_KEY_KEY]: SERVER_KEY,
	});
}

/** Domain deps over the UNHOOKED store, for the injected peer. */
function peerDeps(): AgentSessionDeps {
	const key = base64UrlDecode(SERVER_KEY);
	if (key === null) throw new Error("bad key");
	return {
		store: new EmdashAgentSessionStore({ storage: base }),
		clock: systemClock,
		secrets: new WebCryptoAgentSessionSecrets(key),
	};
}

async function call(
	handler: ReturnType<typeof createAgenticSessionCreateHandler>,
	c: PluginContext,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return (await handler({ input, request: REQUEST } as never, c)) as Record<string, unknown>;
}

const BODY = { idempotencyKey: "race-1", lines: [{ productId: MUG.id, quantity: 1 }] };

beforeEach(async () => {
	({ storage: base } = await makeSqliteStorage(commerceStorageLayout()));
	await seedAgenticStore(base, F);
	await seedProduct(base, LAST, 1, { stock: 1 });
	before = null;
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
}, 120_000);

describe("the agent cart key", () => {
	test("carries the body's fingerprint: two bodies under one key get two carts; one body, one", async () => {
		const a = await agentCartKey("create", "net", "k-1", "fp-a");
		const b = await agentCartKey("create", "net", "k-1", "fp-b");
		expect(a).not.toBe(b);
		expect(await agentCartKey("create", "net", "k-1", "fp-a")).toBe(a);
		expect(await agentCartKey("replace", "net", "k-1", "fp-a")).not.toBe(a);
	});
});

describe("a write refused after its cart was built", () => {
	test("a racer takes the key with another body mid-build: IDEMPOTENCY_KEY_REUSED, and this body's cart is released", async () => {
		const c = ctx();
		let createKeyReads = 0;
		let raced = false;
		// The racer: the same network and key, another body, written straight
		// through the domain. Its network key is the one the route derives, read
		// off a probe session this request's network created.
		const created = await call(createAgenticSessionCreateHandler(), c, {
			idempotencyKey: "probe",
			lines: [{ productId: MUG.id, quantity: 1 }],
		});
		expect(created["ok"]).toBe(true);
		const networkKey = (
			await new EmdashAgentSessionStore({ storage: base }).get(
				(created["session"] as { id: string }).id as never,
			)
		)?.networkKey;
		if (networkKey === undefined) throw new Error("no network key");
		createKeyReads = 0;
		before = async (collection, method) => {
			if (raced || collection !== AGENT_SESSION_CREATE_KEYS_COLLECTION || method !== "get") return;
			createKeyReads++;
			if (createKeyReads < 2) return;
			raced = true;
			const racer = await createAgentSession(peerDeps(), {
				networkKey,
				idempotencyKey: BODY.idempotencyKey,
				fingerprint: "the-racer's-body",
				content: { currency: currency("USD"), lines: [] },
			});
			expect(racer.ok).toBe(true);
		};
		const refused = await call(createAgenticSessionCreateHandler(), c, BODY);
		expect(raced).toBe(true);
		expect(refused).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		// The cart this body built (found by its own key) holds nothing now.
		const client = await makeCommerceClient(sweepContext(base));
		const input = parseAgentSessionInput(BODY);
		if (input === null) throw new Error("bad body");
		const cartKey = await agentCartKey(
			"create",
			networkKey,
			BODY.idempotencyKey,
			await fingerprintOf(input, "create"),
		);
		const { cartId } = await client.createCart(undefined, cartKey);
		expect(await cartLines(base, cartId)).toEqual({});
	});
});

describe("a redeem landing mid-update", () => {
	test("the last unit: the shopper re-adopts the agent's cart holding it; the update is SESSION_HANDED_OFF and its cart released", async () => {
		const c = ctx();
		const created = await call(createAgenticSessionCreateHandler(), c, {
			idempotencyKey: "mid-create",
			lines: [{ productId: LAST.id, quantity: 1 }],
		});
		expect(created).toMatchObject({ ok: true, messages: [] });
		const id = (created["session"] as { id: string }).id;
		const agentCart = (await new EmdashAgentSessionStore({ storage: base }).get(id as never))
			?.cartId;
		if (agentCart === undefined) throw new Error("no cart");

		let redeemed: Record<string, unknown> | null = null;
		before = async (collection) => {
			// The update's first stock call: its new cart is being filled right now.
			if (redeemed !== null || collection !== "inventory") return;
			redeemed = {};
			const shopper = sweepContext(base, undefined, {
				[AGENTIC_ENABLED_KEY]: true,
				[AGENTIC_SERVER_KEY_KEY]: SERVER_KEY,
			});
			redeemed = await call(createAgenticHandoffRedeemHandler(), shopper, {
				token: created["handoffToken"],
			});
		};
		const body = {
			sessionId: id,
			idempotencyKey: "mid-update",
			lines: [{ productId: LAST.id, quantity: 1 }],
			couponCode: "NOPE",
		};
		const updated = await call(createAgenticSessionUpdateHandler(), c, body);
		before = null;

		expect(redeemed).toMatchObject({ ok: true, cartId: agentCart, messages: [] });
		expect(Object.keys((await cartLines(base, agentCart)) ?? {})).toEqual([LAST.sku]);
		expect(updated).toEqual({ ok: false, reason: "SESSION_HANDED_OFF" });
		const input = parseAgentSessionInput(body);
		if (input === null) throw new Error("bad body");
		const client = await makeCommerceClient(sweepContext(base));
		const { cartId: built } = await client.createCart(
			undefined,
			await agentCartKey("replace", id, body.idempotencyKey, await fingerprintOf(input, "replace")),
		);
		expect(built).not.toBe(agentCart);
		expect(await cartLines(base, built)).toEqual({});
	});
});

describe("an update that throws after building its cart", () => {
	test("keeps the keyed cart: the same-key, same-body retry writes a session with its lines and a priced quote", async () => {
		const c = ctx();
		const created = await call(createAgenticSessionCreateHandler(), c, {
			idempotencyKey: "throw-create",
			lines: [{ productId: MUG.id, quantity: 1 }],
		});
		expect(created["ok"]).toBe(true);
		const id = (created["session"] as { id: string }).id;
		const body = {
			sessionId: id,
			idempotencyKey: "throw-update",
			lines: [{ productId: MUG.id, quantity: 2 }],
			destination: AGENT_ADDRESS,
			shippingMethodId: F.methodId,
		};
		let thrown = false;
		before = async (collection, method) => {
			// The update's session write, after its new cart was built and quoted.
			if (thrown || collection !== AGENT_SESSIONS_COLLECTION || method !== "compareAndSet") return;
			thrown = true;
			throw new Error("injected storage failure");
		};
		const failed = await call(createAgenticSessionUpdateHandler(), c, body).catch(() => ({
			ok: false,
			error: "THROWN",
		}));
		before = null;
		expect(thrown).toBe(true);
		expect(failed["ok"]).toBe(false);

		const retried = await call(createAgenticSessionUpdateHandler(), c, body);
		expect(retried).toMatchObject({ ok: true, replayed: false, messages: [] });
		const session = retried["session"] as Record<string, unknown>;
		expect(session["lines"]).toEqual([{ productId: MUG.id, sku: MUG.sku, quantity: 2 }]);
		expect(session["quote"]).toMatchObject({ subtotal: 3000, fulfillment: 599 });
		expect((session["quote"] as { total: number | null }).total).not.toBeNull();
	});
});

describe("acceptedSelection", () => {
	const input = {
		address: {
			name: "A",
			line1: "1 Main St",
			city: "Springfield",
			region: "IL",
			postalCode: "62701",
			country: "US",
		},
		shippingMethodId: "ship",
		couponCode: "SAVE",
	} as never;
	test("only what the quote positively accepted; nothing when no quote was made", () => {
		// A refused coupon, then the quote failed for another reason: no `applied`.
		expect(acceptedSelection(input, {})).toEqual({});
		expect(acceptedSelection(input, { applied: {} })).toEqual({});
		const all = acceptedSelection(input, {
			applied: { destination: { country: "US" }, shippingMethodId: "ship", couponCode: "SAVE" },
		});
		expect(all).toMatchObject({ shippingMethodId: "ship", couponCode: "SAVE" });
		expect(all.destination).toMatchObject({ country: "US", postalCode: "62701" });
	});
});

describe("cancel decides on the session it LEFT", () => {
	test("a redeem between cancel's first read and its write: the shopper's cart is not released", async () => {
		const c = ctx();
		const created = await call(createAgenticSessionCreateHandler(), c, {
			idempotencyKey: "cancel-race",
			lines: [{ productId: MUG.id, quantity: 2 }],
		});
		expect(created["ok"]).toBe(true);
		const id = (created["session"] as { id: string }).id;
		const cartId = (await new EmdashAgentSessionStore({ storage: base }).get(id as never))?.cartId;
		if (cartId === undefined) throw new Error("no cart");
		const lines = await cartLines(base, cartId);
		expect(Object.keys(lines ?? {})).toEqual([MUG.sku]);

		let reads = 0;
		before = async (collection, method) => {
			if (collection !== AGENT_SESSIONS_COLLECTION || method !== "get") return;
			reads++;
			if (reads !== 2) return;
			// The shopper redeems (and re-adopts the agent's cart) right here.
			const redeemed = await redeemAgentHandoff(peerDeps(), {
				token: created["handoffToken"] as string,
			});
			expect(redeemed.ok).toBe(true);
		};
		const canceled = await call(createAgenticSessionCancelHandler(), c, {
			sessionId: id,
			idempotencyKey: "cancel-1",
		});
		before = null;
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(canceled).toMatchObject({ ok: true, session: { status: "canceled", handedOff: true } });
		expect(await cartLines(base, cartId)).toEqual(lines);
	});
});

/** A cart line with only the hold fields varying. */
function line(reservationId: string | null, expiresAt: string | null) {
	return { lineId: "l", sku: "S", productId: "p", qty: 1, reservationId, expiresAt };
}

describe("allHeld", () => {
	const NOW = "2026-10-01T12:00:00.000Z";
	test("a live hold and a digital line are held; a lapsed hold and a lost reservation are not", () => {
		expect(allHeld({ lines: [line("r", "2026-10-01T12:15:00.000Z")] }, NOW)).toBe(true);
		expect(allHeld({ lines: [line(null, null)] }, NOW)).toBe(true);
		expect(allHeld({ lines: [line("r", "2026-10-01T11:59:00.000Z")] }, NOW)).toBe(false);
		expect(allHeld({ lines: [line(null, "2026-10-01T12:15:00.000Z")] }, NOW)).toBe(false);
		expect(allHeld({ lines: [line(null, null), line("r", "2026-10-01T11:00:00.000Z")] }, NOW)).toBe(
			false,
		);
	});
});
