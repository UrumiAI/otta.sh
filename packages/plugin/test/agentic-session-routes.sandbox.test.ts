/**
 * ADR-0047 — the agentic session routes under the REAL workerd sandbox, against
 * the real document store: NOT_FOUND while the store has not opted in; with it on,
 * create / get / update / complete / cancel, the typed messages for refused lines
 * and a refused coupon, idempotent replay, and the trusted network key.
 */
import {
	AGENT_SESSION_CREATE_KEYS_COLLECTION,
	AGENT_SESSION_LINKS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	CARTS_COLLECTION,
	collectionOf,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AGENTIC_ROUTES } from "../src/agentic/routes.js";
import {
	AGENT_ADDRESS,
	agenticFixture,
	call,
	cartLines,
	saveAgentic,
	seedAgenticStore,
	seedProduct,
} from "./helpers/agentic-sandbox.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const F = agenticFixture("asr");
const [MUG, BOWL] = F.products;
/** One unit on hand: the agent's own update must still get it. */
const LAST = { id: "prod-asr-last", sku: "SKU-ASR-LAST", amount: 4000 };
/** Two on hand, asked for three: OUT_OF_STOCK. */
const SCARCE = { id: "prod-asr-scarce", sku: "SKU-ASR-SCARCE", amount: 1000 };

let handle: SandboxHandle;
let storage: StorageAccess;

beforeAll(async () => {
	({ storage } = await storageBridge());
	handle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
	await seedAgenticStore(storage, F);
	await seedProduct(storage, LAST, 1, { stock: 1 });
	await seedProduct(storage, SCARCE, 1, { stock: 2 });
}, 300_000);

afterAll(async () => {
	await handle?.close();
});

/** Documents in every collection an agentic write could touch. */
async function counts(): Promise<Record<string, number>> {
	const names = [
		AGENT_SESSIONS_COLLECTION,
		AGENT_SESSION_LINKS_COLLECTION,
		AGENT_SESSION_CREATE_KEYS_COLLECTION,
		CARTS_COLLECTION,
	];
	const entries = await Promise.all(
		names.map(async (name) => [name, await collectionOf(storage, name).count({})] as const),
	);
	return Object.fromEntries(entries);
}

const cartCount = (): Promise<number> => collectionOf(storage, CARTS_COLLECTION).count({});

/** The session's cart id, as stored (the wire never carries it). */
async function storedCartId(sessionId: string): Promise<string> {
	const doc = await collectionOf<{ cartId?: string }>(storage, AGENT_SESSIONS_COLLECTION).get(
		sessionId,
	);
	if (doc?.cartId === undefined) throw new Error("the session has no cart");
	return doc.cartId;
}

function body(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		idempotencyKey: key,
		lines: [
			{ productId: MUG.id, quantity: 2 },
			{ productId: BOWL.id, sku: BOWL.sku, quantity: 1 },
		],
		destination: AGENT_ADDRESS,
		shippingMethodId: F.methodId,
		...extra,
	};
}

describe("agentic routes, switched off (the default)", () => {
	test("every route answers NOT_FOUND and writes nothing: no session, cart, link pointer or create key", async () => {
		const before = await counts();
		for (const route of AGENTIC_ROUTES) {
			expect(await call(handle, route, body("off-1")), route).toEqual({
				ok: false,
				error: "NOT_FOUND",
			});
		}
		expect(await counts()).toEqual(before);
		// (No server key either: agentic-settings.test.ts pins that on a recording kv.)
	});
});

describe("agentic routes, switched on", () => {
	beforeAll(async () => {
		await saveAgentic(handle, true);
	});
	afterAll(async () => {
		await saveAgentic(handle, false);
	});

	test("status says so", async () => {
		expect(await call(handle, "agentic/status", {})).toEqual({ ok: true, enabled: true });
	});

	test("create: a cart built and quoted by the store's own code; secrets once; never the cart id", async () => {
		const created = await call(handle, "agentic/session/create", body("create-1"));
		expect(created).toMatchObject({ ok: true, noStore: true, replayed: false, messages: [] });
		const session = created["session"] as Record<string, unknown>;
		expect(session).toMatchObject({
			status: "requires_escalation",
			currency: "USD",
			lines: [
				{ productId: MUG.id, sku: MUG.sku, quantity: 2 },
				{ productId: BOWL.id, sku: BOWL.sku, quantity: 1 },
			],
			shippingMethodId: F.methodId,
			handedOff: false,
		});
		expect(session).not.toHaveProperty("cartId");
		// 2 × 15.00 + 22.50 = 52.50; shipping 5.99; 10% tax on both = 5.85.
		expect(session["quote"]).toMatchObject({
			currency: "USD",
			subtotal: 5250,
			discount: 0,
			fulfillment: 599,
			tax: 585,
			total: 6434,
		});
		expect(created["orderSecret"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(created["handoffToken"]).toMatch(/^[A-Za-z0-9_-]{43}$/);

		// The same key and body replays the same answer, secret and link included —
		// with no cart work: still exactly one cart.
		const carts = await cartCount();
		const replay = await call(handle, "agentic/session/create", body("create-1"));
		expect(await cartCount()).toBe(carts);
		expect(replay["handoffToken"]).toBe(created["handoffToken"]);
		// Byte-stable: a second replay is the first, exactly.
		expect(await call(handle, "agentic/session/create", body("create-1"))).toEqual(replay);
		expect(replay).toMatchObject({ ok: true, replayed: true });
		expect((replay["session"] as { id: string }).id).toBe(session["id"]);
		expect(replay["orderSecret"]).toBe(created["orderSecret"]);
		// A different body under the key is refused, building no cart.
		expect(
			await call(handle, "agentic/session/create", body("create-1", { couponCode: "OTHER" })),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		expect(await cartCount()).toBe(carts);
	});

	test("refused lines and a refused coupon are typed messages; the quote is made without them", async () => {
		const created = await call(handle, "agentic/session/create", {
			idempotencyKey: "create-msgs",
			lines: [
				{ productId: MUG.id, quantity: 1 },
				{ productId: "prod-asr-missing", quantity: 1 },
				{ productId: BOWL.id, sku: "SKU-WRONG", quantity: 1 },
			],
			couponCode: "NO-SUCH-CODE",
		});
		expect(created["ok"]).toBe(true);
		expect(created["messages"]).toEqual([
			{ code: "PRODUCT_UNAVAILABLE", path: "lines[1]" },
			{ code: "SKU_MISMATCH", path: "lines[2]" },
			{ code: "COUPON_NOT_FOUND", path: "couponCode" },
		]);
		const session = created["session"] as Record<string, unknown>;
		expect(session["lines"]).toEqual([{ productId: MUG.id, sku: MUG.sku, quantity: 1 }]);
		// The refused coupon is not advertised as applied: its message says why.
		expect(session["couponCode"]).toBeNull();
		// No destination: shipping and tax are not calculated, so there is no total.
		expect(session["quote"]).toMatchObject({
			subtotal: 1500,
			fulfillment: null,
			tax: null,
			total: null,
		});
	});

	test("the network key is the request's, never the body's: no client address is UNAVAILABLE", async () => {
		expect(
			await call(handle, "agentic/session/create", body("create-nonet"), { headers: {} }),
		).toEqual({ ok: false, error: "UNAVAILABLE" });
		expect(await call(handle, "agentic/session/create", { idempotencyKey: "" })).toEqual({
			ok: false,
			error: "INVALID_INPUT",
		});
	});

	test("get answers the session and its live link (no-store); an unknown id is SESSION_NOT_FOUND", async () => {
		const created = await call(handle, "agentic/session/create", body("create-get"));
		const id = (created["session"] as { id: string }).id;
		const got = await call(handle, "agentic/session/get", { sessionId: id });
		expect(got).toMatchObject({ ok: true, noStore: true, handoffToken: created["handoffToken"] });
		expect((got["session"] as { id: string }).id).toBe(id);
		expect(
			await call(handle, "agentic/session/get", { sessionId: "cs_AAAAAAAAAAAAAAAAAAAAAA" }),
		).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });
	});

	test("update replaces the content and re-quotes; complete answers the link; cancel ends it", async () => {
		const created = await call(handle, "agentic/session/create", body("create-upd"));
		const id = (created["session"] as { id: string }).id;
		const updated = await call(handle, "agentic/session/update", {
			sessionId: id,
			...body("update-1", {
				lines: [{ productId: BOWL.id, quantity: 2 }],
				couponCode: F.couponCode,
			}),
		});
		expect(updated).toMatchObject({ ok: true, replayed: false, messages: [] });
		// 2 × 22.50 = 45.00 − 5.00 + 5.99 shipping; 10% tax on 40.00 + 5.99 = 4.60.
		expect((updated["session"] as Record<string, unknown>)["quote"]).toMatchObject({
			subtotal: 4500,
			discount: 500,
			fulfillment: 599,
			tax: 460,
			total: 5059,
		});
		const completed = await call(handle, "agentic/session/complete", {
			sessionId: id,
			idempotencyKey: "complete-1",
		});
		expect(completed).toMatchObject({ ok: true, handoffToken: created["handoffToken"] });

		const canceled = await call(handle, "agentic/session/cancel", {
			sessionId: id,
			idempotencyKey: "cancel-1",
		});
		expect((canceled["session"] as { status: string }).status).toBe("canceled");
		// The link is dead: redeeming it is refused and writes nothing.
		const links = collectionOf(storage, AGENT_SESSION_LINKS_COLLECTION);
		const linkCount = await links.count({});
		expect(
			await call(handle, "agentic/handoff/redeem", { token: created["handoffToken"] }),
		).toEqual({ ok: false, reason: "HANDOFF_CANCELED" });
		expect(await links.count({})).toBe(linkCount);
		expect(
			await call(handle, "agentic/session/update", { sessionId: id, ...body("update-2") }),
		).toEqual({ ok: false, reason: "SESSION_CLOSED" });
	});

	test("after a redeem, the old key with another body leaves the shopper's cart as it was; an update builds no cart", async () => {
		const created = await call(handle, "agentic/session/create", body("create-handed"));
		const id = (created["session"] as { id: string }).id;
		const redeemed = await call(handle, "agentic/handoff/redeem", {
			token: created["handoffToken"],
		});
		expect(redeemed["ok"]).toBe(true);
		const shopperCart = redeemed["cartId"] as string;
		// The agent's own cart was re-adopted: the create key's cart IS the shopper's.
		expect(shopperCart).toBe(await storedCartId(id));
		const lines = await cartLines(storage, shopperCart);
		const carts = await cartCount();

		const extra = { lines: [{ productId: BOWL.id, quantity: 5 }] };
		expect(await call(handle, "agentic/session/create", body("create-handed", extra))).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_REUSED",
		});
		expect(
			await call(handle, "agentic/session/update", {
				sessionId: id,
				...body("create-handed", extra),
			}),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		expect(
			await call(handle, "agentic/session/update", { sessionId: id, ...body("upd-handed", extra) }),
		).toEqual({ ok: false, reason: "SESSION_HANDED_OFF" });

		expect(await cartLines(storage, shopperCart)).toEqual(lines);
		expect(await cartCount()).toBe(carts);
	});

	test("an update replay is byte-stable and does no cart work", async () => {
		const created = await call(handle, "agentic/session/create", body("create-replay-upd"));
		const id = (created["session"] as { id: string }).id;
		const put = {
			sessionId: id,
			...body("put-replay", { lines: [{ productId: MUG.id, quantity: 1 }] }),
		};
		const first = await call(handle, "agentic/session/update", put);
		expect(first).toMatchObject({ ok: true, replayed: false });
		const carts = await cartCount();
		const again = await call(handle, "agentic/session/update", put);
		expect(again).toMatchObject({ ok: true, replayed: true, messages: [] });
		expect(await call(handle, "agentic/session/update", put)).toEqual(again);
		expect(await cartCount()).toBe(carts);
	});

	test("a create replay carries the first answer's messages (OUT_OF_STOCK, a refused coupon)", async () => {
		const ask = {
			idempotencyKey: "create-oos",
			lines: [
				{ productId: MUG.id, quantity: 1 },
				{ productId: SCARCE.id, quantity: 3 },
			],
			couponCode: "NO-SUCH-CODE",
		};
		const first = await call(handle, "agentic/session/create", ask);
		expect(first["messages"]).toEqual([
			{ code: "OUT_OF_STOCK", path: "lines[1]" },
			{ code: "COUPON_NOT_FOUND", path: "couponCode" },
		]);
		const replay = await call(handle, "agentic/session/create", ask);
		expect(replay).toMatchObject({ ok: true, replayed: true, messages: first["messages"] });
		expect(replay["session"]).toEqual(first["session"]);
	});

	test("the LAST unit: an update of the address within the hold keeps the line, priced", async () => {
		const created = await call(handle, "agentic/session/create", {
			idempotencyKey: "create-last",
			lines: [{ productId: LAST.id, quantity: 1 }],
		});
		expect(created).toMatchObject({ ok: true, messages: [] });
		const id = (created["session"] as { id: string }).id;
		const firstCart = await storedCartId(id);
		const updated = await call(handle, "agentic/session/update", {
			sessionId: id,
			idempotencyKey: "update-last",
			lines: [{ productId: LAST.id, quantity: 1 }],
			destination: AGENT_ADDRESS,
			shippingMethodId: F.methodId,
		});
		expect(updated).toMatchObject({ ok: true, replayed: false, messages: [] });
		const session = updated["session"] as Record<string, unknown>;
		expect(session["lines"]).toEqual([{ productId: LAST.id, sku: LAST.sku, quantity: 1 }]);
		expect(session["quote"]).toMatchObject({ subtotal: 4000, fulfillment: 599 });
		// The new cart holds the unit; the old one released it.
		const nextCart = await storedCartId(id);
		expect(nextCart).not.toBe(firstCart);
		expect(Object.keys((await cartLines(storage, nextCart)) ?? {})).toEqual([LAST.sku]);
		expect(await cartLines(storage, firstCart)).toEqual({});
	});

	test("two bodies racing under one key: one session, and only the winner's lines in its cart", async () => {
		const a = { idempotencyKey: "race-key", lines: [{ productId: MUG.id, quantity: 1 }] };
		const b = { idempotencyKey: "race-key", lines: [{ productId: BOWL.id, quantity: 4 }] };
		const [ra, rb] = await Promise.all([
			call(handle, "agentic/session/create", a),
			call(handle, "agentic/session/create", b),
		]);
		const winners = [ra, rb].filter((r) => r["ok"] === true);
		expect(winners).toHaveLength(1);
		expect([ra, rb].filter((r) => r["reason"] === "IDEMPOTENCY_KEY_REUSED")).toHaveLength(1);
		const won = winners[0]!["session"] as { id: string; lines: Array<{ sku: string }> };
		const cart = await cartLines(storage, await storedCartId(won.id));
		expect(Object.keys(cart ?? {})).toEqual(won.lines.map((l) => l.sku));
	});
});
