/**
 * ADR-0047 — the shopper's half of an agentic checkout under the REAL workerd
 * sandbox: an agent session with 2 lines, a destination and a coupon; its quote
 * equals what `storefront/checkout/summary` shows for the same cart; the hand-off
 * link redeems ONCE (a cart cookie and the prefill) and never again; a cash-on-
 * delivery order placed from that cart is attributed to the session, which records
 * the order and completes; `agentic/order` answers only for the right secret.
 * Also: an expired link, a link whose lines no longer fit (no cookie at all), a
 * tampered token (writes nothing), and prices re-read at the hand-off.
 */
import {
	AGENT_SESSIONS_COLLECTION,
	CARTS_COLLECTION,
	collectionOf,
	hashToken,
	INVENTORY_COLLECTION,
	ORDERS_COLLECTION,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	AGENT_ADDRESS,
	AGENTIC_TEST_ENTRY,
	agenticFixture,
	call,
	cartLines,
	saveAgentic,
	seedAgenticStore,
	seedProduct,
	unpublishProduct,
} from "./helpers/agentic-sandbox.js";
import { fingerprintOf, parseAgentSessionInput } from "../src/agentic/input.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const F = agenticFixture("aho");
const [MUG, BOWL] = F.products;
/** Re-priced later in the file; never part of the main flow. */
const PLATE = { id: "prod-aho-plate", sku: "SKU-AHO-PLATE", amount: 1000 };
/** Unpublished mid-test: each case that needs one gets its own. */
const CUP = { id: "prod-aho-cup", sku: "SKU-AHO-CUP", amount: 800 };
const JUG = { id: "prod-aho-jug", sku: "SKU-AHO-JUG", amount: 1200 };
const VASE = { id: "prod-aho-vase", sku: "SKU-AHO-VASE", amount: 900 };
/** A digital product: its cart line takes no reservation and has no deadline. */
const EBOOK = { id: "prod-aho-ebook", sku: "SKU-AHO-EBOOK", amount: 700 };
/** One unit on hand: the transient out-of-stock case. */
const SOLO = { id: "prod-aho-solo", sku: "SKU-AHO-SOLO", amount: 1500 };

let handle: SandboxHandle;
let storage: StorageAccess;

beforeAll(async () => {
	({ storage } = await storageBridge());
	handle = await loadPluginInSandbox({
		allowedHosts: [],
		storage: true,
		entry: AGENTIC_TEST_ENTRY,
	});
	await seedAgenticStore(storage, F);
	for (const product of [PLATE, CUP, JUG, VASE]) await seedProduct(storage, product);
	await seedProduct(storage, EBOOK, 1, { kind: "digital" });
	await seedProduct(storage, SOLO, 1, { stock: 1 });
	await saveAgentic(handle, true);
	const cod = await handle.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-cash-on-delivery",
		values: { codEnabled: true, codInstructions: "" },
	});
	expect(cod).toHaveProperty("result");
}, 300_000);

afterAll(async () => {
	await handle?.close();
});

const DESTINATION = {
	country: AGENT_ADDRESS.country,
	region: AGENT_ADDRESS.region,
	postalCode: AGENT_ADDRESS.postalCode,
	city: AGENT_ADDRESS.city,
};

async function createSession(
	key: string,
	lines: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
): Promise<{ id: string; token: string; orderSecret: string; session: Record<string, unknown> }> {
	const created = await call(handle, "agentic/session/create", {
		idempotencyKey: key,
		lines,
		buyer: { email: "agent-buyer@example.com" },
		destination: AGENT_ADDRESS,
		shippingMethodId: F.methodId,
		couponCode: F.couponCode,
		...extra,
	});
	expect(created["ok"]).toBe(true);
	const session = created["session"] as Record<string, unknown>;
	return {
		id: session["id"] as string,
		token: created["handoffToken"] as string,
		orderSecret: created["orderSecret"] as string,
		session,
	};
}

/** The stored session document (the test's own read of the store). */
async function storedSession(id: string): Promise<Record<string, unknown>> {
	const doc = await collectionOf<Record<string, unknown>>(storage, AGENT_SESSIONS_COLLECTION).get(
		id,
	);
	if (doc === null) throw new Error("missing session");
	return doc;
}

/** Place a COD order from `cartId` through the site's path. */
async function placeCod(cartId: string, ip: string): Promise<Record<string, unknown>> {
	return call(
		handle,
		"storefront/checkout/place",
		{
			cartId,
			// Its own buyer: open COD orders are capped per buyer (ADR-0044).
			buyerRef: `agent-buyer-${ip}@example.com`,
			idempotencyKey: `checkout:${cartId}`,
			paymentMethod: "cod",
			shippingAddress: AGENT_ADDRESS,
			shippingMethodId: F.methodId,
		},
		{ headers: { "x-otta-cod-attest": "rate-limited", "cf-connecting-ip": ip } },
	);
}

/** Redeem a hand-off link as one browser (its redeemer nonce cookie, passed by
 *  the site's shim as the `redeemer` input). */
async function redeem(token: string, redeemer = "browser-aho"): Promise<Record<string, unknown>> {
	return call(handle, "agentic/handoff/redeem", { token, redeemer });
}

/** The bridge methods a collection answers (`sandbox/storage-bridge.ts`). */
const BRIDGED = [
	"get",
	"put",
	"delete",
	"query",
	"count",
	"updateIf",
	"getVersioned",
	"compareAndSet",
	"compareAndDelete",
] as const;

/**
 * Run `action` before the FIRST call the plugin makes to `collection` from here
 * on (a throw is a real storage failure inside the redeem; an await pauses it
 * there), then behave normally. Returns the restore.
 */
function onFirstCall(collection: string, action: () => Promise<void>): () => void {
	const target = storage[collection] as unknown as Record<string, unknown>;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	let fired = false;
	for (const method of BRIDGED) {
		const original = target[method];
		if (typeof original !== "function") continue;
		saved.set(method, Object.getOwnPropertyDescriptor(target, method));
		target[method] = async (...args: unknown[]) => {
			if (!fired) {
				fired = true;
				await action();
			}
			return (original as (...a: unknown[]) => unknown).apply(target, args);
		};
	}
	return () => {
		for (const [method, descriptor] of saved) {
			if (descriptor === undefined) delete target[method];
			else Object.defineProperty(target, method, descriptor);
		}
	};
}

/** A promise and its resolve, for pausing a call from outside. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	const settle: { resolve?: () => void } = {};
	const promise = new Promise<void>((done) => {
		settle.resolve = done;
	});
	return {
		promise,
		resolve: () => {
			settle.resolve?.();
		},
	};
}

async function cartIds(): Promise<Set<string>> {
	const carts = collectionOf(storage, CARTS_COLLECTION);
	const ids = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await carts.query({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
		for (const item of page.items) ids.add(item.id);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return ids;
}

/** The stored line ids of `cartId`, by sku. */
async function lineIds(cartId: string): Promise<Record<string, string>> {
	const doc = await collectionOf<{ lines: Record<string, { lineId: string }> }>(
		storage,
		CARTS_COLLECTION,
	).get(cartId);
	return Object.fromEntries(Object.entries(doc?.lines ?? {}).map(([k, v]) => [k, v.lineId]));
}

async function storedOrder(orderId: string): Promise<Record<string, unknown> | null> {
	return collectionOf<Record<string, unknown>>(storage, ORDERS_COLLECTION).get(orderId);
}

async function editSession(id: string, patch: Record<string, unknown>): Promise<void> {
	const sessions = collectionOf<Record<string, unknown>>(storage, AGENT_SESSIONS_COLLECTION);
	await sessions.put(id, { ...(await storedSession(id)), ...patch });
}

describe("agentic hand-off (workerd sandbox)", () => {
	test("full flow: quote = summary, redeem once, COD order attributed, session completed", async () => {
		const s = await createSession("flow-1", [
			{ productId: MUG.id, quantity: 2 },
			{ productId: BOWL.id, quantity: 1 },
		]);
		const quote = s.session["quote"] as Record<string, number | null>;
		expect(quote["total"]).not.toBeNull();

		// Redeem: the shopper gets a cart of its own; the agent's cart is released.
		const agentCart = (await storedSession(s.id))["cartId"] as string;
		const redeemed = await redeem(s.token);
		expect(redeemed).toMatchObject({
			ok: true,
			noStore: true,
			messages: [],
			prefill: {
				email: "agent-buyer@example.com",
				phone: AGENT_ADDRESS.phone,
				shippingMethodId: F.methodId,
				couponCode: F.couponCode,
				address: { ...AGENT_ADDRESS, line2: null, email: null },
			},
		});
		const cartId = redeemed["cartId"] as string;
		expect(redeemed["cookie"]).toMatchObject({ value: cartId, httpOnly: true, secure: true });
		expect(cartId).not.toBe(agentCart);
		expect((await storedSession(s.id))["shopperCartId"]).toBe(cartId);
		expect(await cartLines(storage, agentCart)).toEqual({});
		expect(Object.keys((await cartLines(storage, cartId)) ?? {}).toSorted()).toEqual(
			[MUG.sku, BOWL.sku].toSorted(),
		);

		// The quote the agent got is exactly what the shopper's checkout shows.
		const summary = await call(handle, "storefront/checkout/summary", {
			cartId,
			couponCode: F.couponCode,
			shippingMethodId: F.methodId,
			destination: DESTINATION,
		});
		expect(summary["ok"]).toBe(true);
		const totals = summary["totals"] as Record<string, { money: { amount: number } | null }>;
		expect({
			subtotal: totals["subtotal"]?.money?.amount,
			discount: totals["discount"]?.money?.amount,
			fulfillment: totals["shipping"]?.money?.amount,
			tax: totals["tax"]?.money?.amount,
			total: totals["total"]?.money?.amount,
		}).toEqual({
			subtotal: quote["subtotal"],
			discount: quote["discount"],
			fulfillment: quote["fulfillment"],
			tax: quote["tax"],
			total: quote["total"],
		});

		// Single use: another browser (the agent holds the token too) is refused,
		// with no cookie; the browser that redeemed re-enters the SAME cart.
		expect(await redeem(s.token, "browser-other")).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
		expect(await redeem(s.token)).toMatchObject({ ok: true, cartId });

		// Before any order, the secret answers the status and no order.
		expect(
			await call(handle, "agentic/order", { sessionId: s.id, orderSecret: s.orderSecret }),
		).toEqual({ ok: true, sessionStatus: "requires_escalation", order: null });

		// The shopper places a COD order from that cart through the site's path.
		const placed = await call(
			handle,
			"storefront/checkout/place",
			{
				cartId,
				buyerRef: "agent-buyer@example.com",
				idempotencyKey: `checkout:${cartId}`,
				paymentMethod: "cod",
				shippingAddress: AGENT_ADDRESS,
				shippingMethodId: F.methodId,
				couponCode: F.couponCode,
			},
			{ headers: { "x-otta-cod-attest": "rate-limited", "cf-connecting-ip": "203.0.113.9" } },
		);
		expect(placed).toMatchObject({ ok: true, state: "awaiting_payment" });
		const orderId = placed["orderId"] as string;
		const order = await collectionOf<Record<string, unknown>>(storage, ORDERS_COLLECTION).get(
			orderId,
		);
		expect(order?.["attribution"]).toEqual({ channel: "agent", via: "handoff", sessionId: s.id });
		expect(order?.["channel"]).toBe("agent");

		// The session recorded the order and completed: no agent write is accepted.
		const got = await call(handle, "agentic/session/get", { sessionId: s.id });
		expect(got["session"]).toMatchObject({ status: "completed", orderId, handedOff: true });
		expect(
			await call(handle, "agentic/session/complete", { sessionId: s.id, idempotencyKey: "late-1" }),
		).toMatchObject({ ok: false });

		// The order's status, only for the right secret.
		expect(
			await call(handle, "agentic/order", { sessionId: s.id, orderSecret: s.orderSecret }),
		).toEqual({
			ok: true,
			sessionStatus: "completed",
			order: { id: orderId, state: "awaiting_payment" },
		});
		expect(
			await call(handle, "agentic/order", { sessionId: s.id, orderSecret: "x".repeat(43) }),
		).toEqual({ ok: false, reason: "ORDER_SECRET_INVALID" });
	});

	test("an order from an ordinary cart carries no attribution", async () => {
		const created = await call(handle, "storefront/cart/create", {});
		const cartId = created["cartId"] as string;
		expect(
			await call(handle, "storefront/cart/lines/add", {
				cartId,
				sku: MUG.sku,
				productId: MUG.id,
				qty: 1,
				idempotencyKey: `add-${cartId}`,
			}),
		).toMatchObject({ ok: true });
		const placed = await call(
			handle,
			"storefront/checkout/place",
			{
				cartId,
				buyerRef: "plain-buyer@example.com",
				idempotencyKey: `checkout:${cartId}`,
				paymentMethod: "cod",
				shippingAddress: AGENT_ADDRESS,
				shippingMethodId: F.methodId,
			},
			{ headers: { "x-otta-cod-attest": "rate-limited", "cf-connecting-ip": "203.0.113.10" } },
		);
		expect(placed["ok"]).toBe(true);
		const order = await collectionOf<Record<string, unknown>>(storage, ORDERS_COLLECTION).get(
			placed["orderId"] as string,
		);
		expect(order).not.toHaveProperty("attribution");
	});

	test("an expired link is HANDOFF_EXPIRED and leaves the session as it was", async () => {
		const s = await createSession("expired-1", [{ productId: MUG.id, quantity: 1 }]);
		await editSession(s.id, { expiresAt: "2020-01-01T00:00:00.000Z" });
		const before = await storedSession(s.id);
		expect(await redeem(s.token)).toEqual({
			ok: false,
			reason: "HANDOFF_EXPIRED",
		});
		expect(await storedSession(s.id)).toEqual(before);
	});

	test("a tampered or unknown token is HANDOFF_INVALID and writes nothing", async () => {
		const sessions = collectionOf(storage, AGENT_SESSIONS_COLLECTION);
		const count = await sessions.count({});
		for (const token of ["x".repeat(43), "short", ""]) {
			expect(await redeem(token)).toEqual({
				ok: false,
				reason: "HANDOFF_INVALID",
			});
		}
		expect(await sessions.count({})).toBe(count);
	});

	test("ZERO lines fit a cart: a typed refusal with NO cart cookie", async () => {
		const s = await createSession("zero-1", [{ productId: MUG.id, quantity: 1 }]);
		// The agent's cart is gone and the product is no longer sold.
		await editSession(s.id, {
			cartId: "cart-aho-gone",
			lines: [{ productId: "prod-aho-gone", sku: "SKU-AHO-GONE", quantity: 1 }],
		});
		const refused = await redeem(s.token);
		expect(refused).toEqual({
			ok: false,
			reason: "HANDOFF_NO_LINES",
			messages: [{ code: "PRODUCT_UNAVAILABLE", path: "lines[0]" }],
		});
		expect(refused).not.toHaveProperty("cookie");
		expect(refused).not.toHaveProperty("cartId");
		// Never finalized, and the claim released: the link is still redeemable.
		const after = await storedSession(s.id);
		expect(after).not.toHaveProperty("handoffUsedAt");
		expect(after).not.toHaveProperty("shopperCartId");
		expect(after).not.toHaveProperty("handoffClaim");
	});

	test("prices are re-read at the hand-off: the shopper's checkout shows today's price, not the quote's", async () => {
		const s = await createSession("price-1", [{ productId: PLATE.id, quantity: 1 }], {
			couponCode: undefined,
		});
		expect((s.session["quote"] as { subtotal: number }).subtotal).toBe(1000);
		await seedProduct(storage, { ...PLATE, amount: 1200 }, 2);
		const redeemed = await redeem(s.token);
		expect(redeemed["ok"]).toBe(true);
		const summary = await call(handle, "storefront/checkout/summary", {
			cartId: redeemed["cartId"],
			shippingMethodId: F.methodId,
			destination: DESTINATION,
		});
		const totals = summary["totals"] as Record<string, { money: { amount: number } | null }>;
		expect(totals["subtotal"]?.money?.amount).toBe(1200);
	});

	test("sellability is checked: the agent's cart still exists but its product is unpublished → no cookie, the agent's cart untouched", async () => {
		const s2 = await createSession("unsold-1", [{ productId: VASE.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const agentCart = (await storedSession(s2.id))["cartId"] as string;
		const before = await cartLines(storage, agentCart);
		expect(Object.keys(before ?? {})).toEqual([VASE.sku]);
		await unpublishProduct(storage, VASE.id);
		const refused = await redeem(s2.token);
		expect(refused).toEqual({
			ok: false,
			reason: "HANDOFF_NO_LINES",
			messages: [{ code: "PRODUCT_UNAVAILABLE", path: "lines[0]" }],
		});
		expect(refused).not.toHaveProperty("cookie");
		expect(await cartLines(storage, agentCart)).toEqual(before);
	});

	test("one product unpublished → the shopper's cart holds the rest, is recorded on the session, and its order attributed", async () => {
		const s2 = await createSession(
			"rebuild-1",
			[
				{ productId: MUG.id, quantity: 1 },
				{ productId: CUP.id, quantity: 1 },
			],
			{ couponCode: undefined },
		);
		const agentCart = (await storedSession(s2.id))["cartId"] as string;
		await unpublishProduct(storage, CUP.id);
		const redeemed = await redeem(s2.token);
		expect(redeemed).toMatchObject({
			ok: true,
			messages: [{ code: "PRODUCT_UNAVAILABLE", path: "lines[1]" }],
		});
		const cartId = redeemed["cartId"] as string;
		expect(cartId).not.toBe(agentCart);
		expect(Object.keys((await cartLines(storage, cartId)) ?? {})).toEqual([MUG.sku]);
		// The finalize recorded the shopper's cart on the session...
		expect((await storedSession(s2.id))["shopperCartId"]).toBe(cartId);
		// ...and the agent's dead cart released its holds.
		expect(await cartLines(storage, agentCart)).toEqual({});
		const placed = await placeCod(cartId, "203.0.113.11");
		expect(placed["ok"]).toBe(true);
		expect((await storedOrder(placed["orderId"] as string))?.["attribution"]).toEqual({
			channel: "agent",
			via: "handoff",
			sessionId: s2.id,
		});
		expect((await storedSession(s2.id))["status"]).toBe("completed");
	});

	test("cancel after redeem, then place: the order stands UNATTRIBUTED, the session stays canceled, the reason code alone is logged", async () => {
		const s2 = await createSession("cancel-after-1", [{ productId: MUG.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const redeemed = await redeem(s2.token);
		const cartId = redeemed["cartId"] as string;
		const canceled = await call(handle, "agentic/session/cancel", {
			sessionId: s2.id,
			idempotencyKey: "cancel-after",
		});
		expect(canceled).toMatchObject({ ok: true, session: { status: "canceled", handedOff: true } });
		// Handed off: the shopper's cart is NEVER released by the agent's cancel.
		expect(Object.keys((await cartLines(storage, cartId)) ?? {})).toEqual([MUG.sku]);

		const logged = handle.workerOutput().length;
		const placed = await placeCod(cartId, "203.0.113.12");
		expect(placed).toMatchObject({ ok: true, state: "awaiting_payment" });
		expect(await storedOrder(placed["orderId"] as string)).not.toHaveProperty("attribution");
		const session = await storedSession(s2.id);
		expect(session["status"]).toBe("canceled");
		expect(session).not.toHaveProperty("orderId");
		const output = handle.workerOutput().slice(logged);
		expect(output).toContain(
			"order placed; agent attribution skipped for its hand-off cart (SESSION_CLOSED)",
		);
		expect(output).not.toContain(s2.id);
		expect(output).not.toContain(cartId);
	});

	test("agentic/order: an unknown session is ORDER_SECRET_INVALID; an order that cannot be read answers order null", async () => {
		expect(
			await call(handle, "agentic/order", {
				sessionId: "cs_AAAAAAAAAAAAAAAAAAAAAA",
				orderSecret: "x".repeat(43),
			}),
		).toEqual({ ok: false, reason: "ORDER_SECRET_INVALID" });
		const s2 = await createSession("order-unreadable", [{ productId: MUG.id, quantity: 1 }]);
		await editSession(s2.id, { orderId: "order-aho-missing", status: "completed" });
		expect(
			await call(handle, "agentic/order", { sessionId: s2.id, orderSecret: s2.orderSecret }),
		).toEqual({ ok: true, sessionStatus: "completed", order: null });
	});

	test("a lapsed hold on the agent's cart: the shopper's cart takes the line afresh", async () => {
		const s2 = await createSession("lapsed-1", [{ productId: JUG.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const agentCart = (await storedSession(s2.id))["cartId"] as string;
		const carts = collectionOf<{ lines: Record<string, { expiresAt: string | null }> }>(
			storage,
			CARTS_COLLECTION,
		);
		const doc = await carts.get(agentCart);
		if (doc === null) throw new Error("no agent cart");
		for (const line of Object.values(doc.lines)) line.expiresAt = "2020-01-01T00:00:00.000Z";
		await carts.put(agentCart, doc);
		const redeemed = await redeem(s2.token);
		expect(redeemed).toMatchObject({ ok: true, messages: [] });
		expect(redeemed["cartId"]).not.toBe(agentCart);
		expect(Object.keys((await cartLines(storage, redeemed["cartId"] as string)) ?? {})).toEqual([
			JUG.sku,
		]);
	});

	test("a digital line (no reservation, no deadline) moves to the shopper's own cart", async () => {
		const s2 = await createSession("digital-1", [{ productId: EBOOK.id, quantity: 1 }], {
			couponCode: undefined,
			shippingMethodId: undefined,
		});
		const agentCart = (await storedSession(s2.id))["cartId"] as string;
		const redeemed = await redeem(s2.token);
		expect(redeemed).toMatchObject({ ok: true, messages: [] });
		expect(redeemed["cartId"]).not.toBe(agentCart);
		expect(Object.keys((await cartLines(storage, redeemed["cartId"] as string)) ?? {})).toEqual([
			EBOOK.sku,
		]);
		expect(await cartLines(storage, agentCart)).toEqual({});
	});

	// ── #712 review, blocker 1: the agent can never reach the shopper's cart ──
	test("an agent cannot name any cart of its session through the public cart/create, and no answer carries a cart id", async () => {
		const s = await createSession("exploit-1", [{ productId: MUG.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const upd = {
			sessionId: s.id,
			idempotencyKey: "exploit-upd",
			lines: [{ productId: MUG.id, quantity: 2 }],
			destination: AGENT_ADDRESS,
			shippingMethodId: F.methodId,
		};
		const updated = await call(handle, "agentic/session/update", upd);
		expect(updated["ok"]).toBe(true);
		const agentCart = (await storedSession(s.id))["cartId"] as string;
		const redeemed = await redeem(s.token);
		expect(redeemed["ok"]).toBe(true);
		const shopperCart = redeemed["cartId"] as string;
		const shopperLines = await cartLines(storage, shopperCart);

		// What the agent knows: its session id, its key, its own body. d0cc4f60 keyed
		// the update's cart on a plain SHA-256 of exactly those, so the agent could
		// recompute it and have cart/create answer the cart (then re-adopted as the
		// shopper's). Under the HMAC (and the storefront's `agentic:` refusal) it
		// names nothing of the session's.
		const input = parseAgentSessionInput(upd);
		if (input === null) throw new Error("bad body");
		const fp = await fingerprintOf(input, "replace");
		const oldKey = `agentic:replace:${await hashToken(`${s.id}\u0000exploit-upd\u0000${fp}`)}`;
		const got = await call(handle, "storefront/cart/create", { idempotencyKey: oldKey });
		expect(got["ok"]).toBe(true);
		expect(got["cartId"]).not.toBe(shopperCart);
		expect(got["cartId"]).not.toBe(agentCart);
		// Its edits land in its own cart, never the shopper's.
		expect(
			await call(handle, "storefront/cart/lines/add", {
				cartId: got["cartId"],
				sku: BOWL.sku,
				productId: BOWL.id,
				qty: 1,
				idempotencyKey: `exploit-add-${String(got["cartId"])}`,
			}),
		).toMatchObject({ ok: true });
		expect(await cartLines(storage, shopperCart)).toEqual(shopperLines);

		// Every agent-facing answer (writes, a replay, reads, refusals) is cart-id free.
		const answers = [
			s.session,
			updated,
			await call(handle, "agentic/session/update", upd),
			await call(handle, "agentic/session/get", { sessionId: s.id }),
			await call(handle, "agentic/session/update", { ...upd, idempotencyKey: "exploit-late" }),
			await call(handle, "agentic/session/complete", {
				sessionId: s.id,
				idempotencyKey: "exploit-complete",
			}),
			await redeem(s.token, "browser-agent"),
			await call(handle, "agentic/session/cancel", {
				sessionId: s.id,
				idempotencyKey: "exploit-cancel",
			}),
		];
		const wire = JSON.stringify(answers);
		expect(wire).not.toContain(agentCart);
		expect(wire).not.toContain(shopperCart);
		expect(wire).not.toMatch(/"(cartId|shopperCartId)"/);
	});

	// ── #712 review, blocker 2: no transient failure kills the link ───────────
	test("a storage error after the claim: the claim is released, and the retry succeeds with exactly ONE cart", async () => {
		const s = await createSession("inject-1", [{ productId: MUG.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const before = await cartIds();
		const restore = onFirstCall(INVENTORY_COLLECTION, () =>
			Promise.reject(new Error("injected storage fault")),
		);
		let failed: unknown;
		try {
			failed = await handle.invokeRoute(
				"agentic/handoff/redeem",
				{ token: s.token, redeemer: "browser-inject" },
				{ headers: {} },
			);
		} finally {
			restore();
		}
		expect(JSON.stringify(failed)).not.toContain('"ok":true');
		const mid = await storedSession(s.id);
		expect(mid).not.toHaveProperty("handoffClaim");
		expect(mid).not.toHaveProperty("handoffUsedAt");

		const redeemed = await redeem(s.token, "browser-inject");
		expect(redeemed).toMatchObject({ ok: true, messages: [] });
		const created = [...(await cartIds())].filter((id) => !before.has(id));
		expect(created).toEqual([redeemed["cartId"]]);
		expect(await cartLines(storage, redeemed["cartId"] as string)).toEqual({
			[MUG.sku]: { qty: 1 },
		});
	});

	test("out of stock for a moment: HANDOFF_NO_LINES writes no hand-off; once stock frees, the link redeems", async () => {
		const s = await createSession("transient-1", [{ productId: SOLO.id, quantity: 1 }], {
			couponCode: undefined,
		});
		// The one unit is held by a cart no longer the session's (its hold outlives
		// the pointer): nothing to move it from.
		const holder = (await storedSession(s.id))["cartId"] as string;
		await editSession(s.id, { cartId: "cart-aho-elsewhere" });
		const refused = await redeem(s.token);
		expect(refused).toEqual({
			ok: false,
			reason: "HANDOFF_NO_LINES",
			messages: [{ code: "OUT_OF_STOCK", path: "lines[0]" }],
		});
		const mid = await storedSession(s.id);
		expect(mid).not.toHaveProperty("handoffUsedAt");
		expect(mid).not.toHaveProperty("handoffClaim");

		const lineId = (await lineIds(holder))[SOLO.sku];
		expect(
			await call(handle, "storefront/cart/lines/remove", {
				cartId: holder,
				lineId,
				idempotencyKey: `free-${holder}`,
			}),
		).toMatchObject({ ok: true });
		const redeemed = await redeem(s.token);
		expect(redeemed).toMatchObject({ ok: true, messages: [] });
		expect(await cartLines(storage, redeemed["cartId"] as string)).toEqual({
			[SOLO.sku]: { qty: 1 },
		});
	});

	test("two redeems from ONE browser at once: one claims, the other is HANDOFF_IN_PROGRESS then re-enters; one cart", async () => {
		const s = await createSession("twin-1", [{ productId: BOWL.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const before = await cartIds();
		const both = await Promise.all([
			redeem(s.token, "browser-twin"),
			redeem(s.token, "browser-twin"),
		]);
		const won = both.filter((r) => r["ok"] === true);
		expect(won.length).toBeGreaterThanOrEqual(1);
		for (const lost of both.filter((r) => r["ok"] !== true)) {
			expect(lost).toEqual({ ok: false, reason: "HANDOFF_IN_PROGRESS" });
		}
		const cartId = won[0]?.["cartId"];
		for (const r of won) expect(r["cartId"]).toBe(cartId);
		expect(await redeem(s.token, "browser-twin")).toMatchObject({ ok: true, cartId });
		expect([...(await cartIds())].filter((id) => !before.has(id))).toEqual([cartId]);
	});

	test("a cancel lands DURING a claim: the cancel wins, the redeem is HANDOFF_CANCELED and its cart released", async () => {
		const s = await createSession("cancel-claim-1", [{ productId: MUG.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const before = await cartIds();
		const gate = deferred();
		const paused = deferred();
		// The redeem holds its claim and is filling the shopper's cart right now.
		const restore = onFirstCall(INVENTORY_COLLECTION, async () => {
			paused.resolve();
			await gate.promise;
		});
		const pending = redeem(s.token, "browser-cc");
		try {
			await paused.promise;
			expect((await storedSession(s.id))["handoffClaim"]).toBeDefined();
			const canceled = await call(handle, "agentic/session/cancel", {
				sessionId: s.id,
				idempotencyKey: "cc-1",
			});
			expect(canceled).toMatchObject({
				ok: true,
				session: { status: "canceled", handedOff: false },
			});
		} finally {
			gate.resolve();
			restore();
		}
		expect(await pending).toEqual({ ok: false, reason: "HANDOFF_CANCELED" });
		const after = await storedSession(s.id);
		expect(after["status"]).toBe("canceled");
		expect(after).not.toHaveProperty("handoffUsedAt");
		expect(after).not.toHaveProperty("shopperCartId");
		for (const id of [...(await cartIds())].filter((c) => !before.has(c))) {
			expect(await cartLines(storage, id)).toEqual({});
		}
		expect(await redeem(s.token, "browser-cc")).toEqual({ ok: false, reason: "HANDOFF_CANCELED" });
	});

	test("no redeemer nonce (the site's cookie is missing): HANDOFF_REDEEMER_MISSING, retryable, nothing written", async () => {
		const s = await createSession("nonce-1", [{ productId: MUG.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const before = await storedSession(s.id);
		expect(await call(handle, "agentic/handoff/redeem", { token: s.token })).toEqual({
			ok: false,
			reason: "HANDOFF_REDEEMER_MISSING",
		});
		expect(await storedSession(s.id)).toEqual(before);
		expect(await redeem(s.token)).toMatchObject({ ok: true });
	});

	// Last: it switches agentic checkout off.
	test("switched OFF after a redeem: the order is placed unattributed and AGENTIC_DISABLED is logged", async () => {
		const s2 = await createSession("off-after-1", [{ productId: MUG.id, quantity: 1 }], {
			couponCode: undefined,
		});
		const redeemed = await redeem(s2.token);
		const cartId = redeemed["cartId"] as string;
		await saveAgentic(handle, false);
		const logged = handle.workerOutput().length;
		const placed = await placeCod(cartId, "203.0.113.13");
		expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true });
		expect(await storedOrder(placed["orderId"] as string)).not.toHaveProperty("attribution");
		expect(handle.workerOutput().slice(logged)).toContain(
			"order placed; agent attribution skipped for its hand-off cart (AGENTIC_DISABLED)",
		);
		await saveAgentic(handle, true);
	});
});
