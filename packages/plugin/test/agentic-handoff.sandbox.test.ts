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
	collectionOf,
	ORDERS_COLLECTION,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	AGENT_ADDRESS,
	agenticFixture,
	call,
	saveAgentic,
	seedAgenticStore,
	seedProduct,
} from "./helpers/agentic-sandbox.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const F = agenticFixture("aho");
const [MUG, BOWL] = F.products;
/** Re-priced later in the file; never part of the main flow. */
const PLATE = { id: "prod-aho-plate", sku: "SKU-AHO-PLATE", amount: 1000 };

let handle: SandboxHandle;
let storage: StorageAccess;

beforeAll(async () => {
	({ storage } = await storageBridge());
	handle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
	await seedAgenticStore(storage, F);
	await seedProduct(storage, PLATE);
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

		// Redeem: the agent's cart still holds the same lines, so it is re-adopted.
		const redeemed = await call(handle, "agentic/handoff/redeem", { token: s.token });
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
		expect((await storedSession(s.id))["cartId"]).toBe(cartId);

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

		// Single use: a second redeem is refused, with no cookie.
		expect(await call(handle, "agentic/handoff/redeem", { token: s.token })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});

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
		expect(await call(handle, "agentic/handoff/redeem", { token: s.token })).toEqual({
			ok: false,
			reason: "HANDOFF_EXPIRED",
		});
		expect(await storedSession(s.id)).toEqual(before);
	});

	test("a tampered or unknown token is HANDOFF_INVALID and writes nothing", async () => {
		const sessions = collectionOf(storage, AGENT_SESSIONS_COLLECTION);
		const count = await sessions.count({});
		for (const token of ["x".repeat(43), "short", ""]) {
			expect(await call(handle, "agentic/handoff/redeem", { token })).toEqual({
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
		const refused = await call(handle, "agentic/handoff/redeem", { token: s.token });
		expect(refused).toEqual({
			ok: false,
			reason: "HANDOFF_NO_LINES",
			messages: [{ code: "PRODUCT_UNAVAILABLE", path: "lines[0]" }],
		});
		expect(refused).not.toHaveProperty("cookie");
		expect(refused).not.toHaveProperty("cartId");
	});

	test("prices are re-read at the hand-off: the shopper's checkout shows today's price, not the quote's", async () => {
		const s = await createSession("price-1", [{ productId: PLATE.id, quantity: 1 }], {
			couponCode: undefined,
		});
		expect((s.session["quote"] as { subtotal: number }).subtotal).toBe(1000);
		await seedProduct(storage, { ...PLATE, amount: 1200 }, 2);
		const redeemed = await call(handle, "agentic/handoff/redeem", { token: s.token });
		expect(redeemed["ok"]).toBe(true);
		const summary = await call(handle, "storefront/checkout/summary", {
			cartId: redeemed["cartId"],
			shippingMethodId: F.methodId,
			destination: DESTINATION,
		});
		const totals = summary["totals"] as Record<string, { money: { amount: number } | null }>;
		expect(totals["subtotal"]?.money?.amount).toBe(1200);
	});
});
