/** Merchant management routes (private, also MCP tools) + public availability. */
import type { PluginContext } from "emdash/plugin";
import {
	MAX_LINES,
	type OrderDoc,
	type OrderStatus,
	type ProductDoc,
	type StockDoc,
} from "./model.js";
import { completeStock, redactOrder, updateOrder } from "./orders.js";
import { available, held, applyStock } from "./stock.js";
import { asId, asInt, asRecord, asString, coll, fail, nowIso } from "./util.js";

/** Order statuses (the admin page's Status menu shows them in this order). */
export const STATUSES = ["review", "pending", "paid", "fulfilled", "expired", "canceled"];

/** Calls: 1 query. */
export async function ordersList(input: unknown, ctx: PluginContext) {
	const i = asRecord(input);
	const st = asString(i["status"], 20);
	if (i["status"] != null && (!st || !STATUSES.includes(st)))
		return fail(
			"BAD_INPUT",
			"status must be one of: pending, paid, fulfilled, review, expired, canceled.",
		);
	const limit = i["limit"] == null ? 20 : asInt(i["limit"], 1, 50);
	if (limit === null) return fail("BAD_INPUT", "limit must be a whole number from 1 to 50.");
	const r = await coll<OrderDoc>(ctx, "orders").query({
		orderBy: { createdAt: "desc" },
		limit,
		...(st ? { where: { status: st as OrderStatus } } : {}),
		...(typeof i["cursor"] === "string" ? { cursor: i["cursor"] } : {}),
	});
	return {
		ok: true as const,
		orders: r.items.map(({ id, data: o }) => ({
			id,
			status: o.status,
			total: o.total,
			currency: o.currency,
			createdAt: o.createdAt,
			paidAt: o.paidAt,
			attention: o.attention,
			email: o.email,
		})),
		...(r.hasMore && r.cursor ? { cursor: r.cursor } : {}),
	};
}

const view = (id: string, o: OrderDoc) => ({ id, ...redactOrder(o) });

/** Calls: 1 get. */
export async function ordersGet(input: unknown, ctx: PluginContext) {
	const id = asId(asRecord(input)["id"]);
	if (!id)
		return fail(
			"BAD_INPUT",
			"id must be an order id (ord_ followed by 32 letters and digits). Get one from list_orders.",
		);
	const o = await coll<OrderDoc>(ctx, "orders").get(id);
	return o ? { ok: true as const, order: view(id, o) } : fail("ORDER_NOT_FOUND", "No such order");
}

/** Calls: 2 per attempt (getVersioned + CAS), up to 5 attempts (updateOrder). */
export async function ordersFulfil(input: unknown, ctx: PluginContext) {
	const i = asRecord(input);
	const id = asId(i["id"]);
	if (!id)
		return fail(
			"BAD_INPUT",
			"id must be an order id (ord_ followed by 32 letters and digits). Get one from list_orders.",
		);
	const tracking = i["tracking"] == null ? null : asString(i["tracking"], 200);
	if (i["tracking"] != null && tracking === null)
		return fail("BAD_INPUT", "tracking must be text of at most 200 characters.");
	let wrong: string | null = null;
	let r;
	try {
		r = await updateOrder(ctx, id, (o) => {
			wrong = null;
			if (o.status === "fulfilled") return null;
			if (o.status !== "paid") {
				wrong = o.status;
				return null;
			}
			return { ...o, status: "fulfilled", fulfilledAt: nowIso(), tracking };
		});
	} catch {
		return fail("CONFLICT", "The order changed while saving. Reload it and try again.");
	}
	if (!r) return fail("ORDER_NOT_FOUND", "No such order");
	if (wrong !== null)
		return fail(
			"ORDER_NOT_PAYABLE",
			`Only a paid order can be marked fulfilled. This order is ${wrong}.`,
		);
	return { ok: true as const, order: view(id, r.value) };
}

/**
 * Resolve an order in `review` (Stripe took money that did not match, or its
 * session became unreachable). accept = it is a sale: paid, stock committed.
 * release = not a sale (refund it in Stripe): canceled, holds returned.
 * Idempotent: repeating the same action returns ok.
 * Calls: 2 + stock completion (2 per tracked line + 1).
 */
export async function ordersResolve(input: unknown, ctx: PluginContext) {
	const i = asRecord(input);
	const id = asId(i["id"]);
	const action = i["action"];
	if (!id)
		return fail(
			"BAD_INPUT",
			"id must be an order id (ord_ followed by 32 letters and digits). Get one from list_orders.",
		);
	if (action !== "accept" && action !== "release")
		return fail("BAD_INPUT", "action must be accept or release");
	const target = action === "accept" ? "paid" : "canceled";
	let wrong: string | null = null;
	const r = await updateOrder(ctx, id, (d) => {
		wrong = null;
		if (d.status === target) return null;
		if (d.status !== "review") {
			wrong = d.status;
			return null;
		}
		// Never claim money that did not move: accept needs a payment on the order.
		// A fully discounted promo order is a recorded payment of 0 with no PaymentIntent.
		const freePaid = d.promoCodes && d.paidAt !== null && d.amountPaid === 0;
		if (action === "accept" && !freePaid && (d.paymentIntentId === null || d.amountPaid === null)) {
			wrong = "NO_PAYMENT";
			return null;
		}
		return action === "accept"
			? { ...d, status: "paid", stock: "committing", stockPending: 1 }
			: {
					...d,
					status: "canceled",
					stock: "releasing",
					stockPending: 1,
					cancelReason: d.attention ?? "RELEASED_FROM_REVIEW",
				};
	});
	if (!r) return fail("ORDER_NOT_FOUND", "No such order");
	if (wrong === "NO_PAYMENT")
		return fail(
			"NO_PAYMENT",
			"No payment is recorded on this order, so it cannot be accepted as a sale; release it",
		);
	if (wrong !== null)
		return fail(
			"ORDER_NOT_IN_REVIEW",
			`Only an order in review can be accepted or released. This order is ${wrong}.`,
		);
	const done = await completeStock(ctx, id, r);
	return { ok: true as const, order: view(id, done.value) };
}

/** Calls: 2 (stock read + CAS). */
export async function stockSet(input: unknown, ctx: PluginContext) {
	const i = asRecord(input);
	const productId = asId(i["productId"]);
	const onHand = asInt(i["onHand"], 0, 1_000_000);
	// The on-hand the caller last saw: a retry after sales, or a stale screen, is
	// refused instead of overwriting them. A caller key makes a retry a no-op.
	const expected = asInt(i["expectedOnHand"], -1_000_000, 1_000_000);
	const key = i["key"] === undefined ? crypto.randomUUID() : asId(i["key"]);
	if (!productId || onHand === null || expected === null || key === null)
		return fail(
			"BAD_INPUT",
			"productId, onHand (a whole number from 0 to 1,000,000) and expectedOnHand are required.",
		);
	const r = await applyStock(ctx, productId, {
		kind: "set",
		key: `admin:${key}`,
		onHand,
		expected,
	});
	if (r.ok === false && r.code === "STOCK_CHANGED") {
		const d = await coll<StockDoc>(ctx, "stock").get(productId);
		return {
			...fail(
				"STOCK_CHANGED",
				"Stock changed since you read it (a sale or another edit). Nothing was saved. Check the current numbers and set it again.",
			),
			stock: d ? { productId, onHand: d.onHand, held: held(d), available: available(d) } : null,
		};
	}
	if (!r.ok) return fail(r.code, "Stock update failed, retry");
	return {
		ok: true as const,
		stock: { productId, onHand: r.doc.onHand, held: held(r.doc), available: available(r.doc) },
	};
}

const AVAILABILITY_CAP = 10;

/** Calls: 1 products query + 1 stock getMany when any product is tracked (<= 2). */
export async function availability(query: unknown, ctx: PluginContext) {
	const raw = asRecord(query)["ids"];
	const ids = [
		...new Set(
			String(raw ?? "")
				.split(",")
				.map((x) => asId(x.trim()))
				.filter((x): x is string => !!x),
		),
	].slice(0, MAX_LINES);
	const out: Record<
		string,
		{
			title: string;
			price: number | null;
			currency: string;
			active: boolean;
			available: number | null;
		}
	> = {};
	if (!ids.length) return { ok: true as const, products: out };
	const r = await coll<ProductDoc>(ctx, "products").query({
		where: { productId: { in: ids } },
		limit: ids.length,
	});
	const tracked = r.items
		.filter((x) => x.data.active && x.data.trackStock)
		.map((x) => x.data.productId);
	const docs = tracked.length
		? await coll<StockDoc>(ctx, "stock").getMany(tracked)
		: new Map<string, StockDoc>();
	for (const { data: p } of r.items) {
		// Public route: products that are not on sale are not disclosed.
		if (!p.active) continue;
		// Capped: a storefront can say "only 3 left" without publishing inventory.
		const a = p.trackStock
			? Math.min(available(docs.get(p.productId) ?? null), AVAILABILITY_CAP)
			: null;
		out[p.productId] = {
			title: p.title,
			price: p.price,
			currency: p.currency,
			active: p.active,
			available: a,
		};
	}
	return { ok: true as const, products: out };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object",
	properties,
	required,
});

/** MCP tool metadata the manifest embeds. */
export const MCP_TOOLS = [
	{
		name: "list_orders",
		description: "List orders, newest first. Optional status filter.",
		route: "orders/list",
		permission: "plugins:manage",
		destructive: false,
		inputSchema: obj({
			status: { type: "string", enum: STATUSES },
			limit: { type: "integer", minimum: 1, maximum: 50 },
			cursor: { type: "string" },
		}),
	},
	{
		name: "get_order",
		description: "Get one order by id.",
		route: "orders/get",
		permission: "plugins:manage",
		destructive: false,
		inputSchema: obj({ id: { type: "string" } }, ["id"]),
	},
	{
		name: "fulfil_order",
		description: "Mark a paid order as fulfilled, optionally with a tracking reference.",
		route: "orders/fulfil",
		permission: "plugins:manage",
		destructive: true,
		inputSchema: obj({ id: { type: "string" }, tracking: { type: "string" } }, ["id"]),
	},
	{
		name: "resolve_order",
		description:
			"Resolve an order in review: accept it as a sale (commits stock; only when a payment is recorded on the order) or release it (cancels it and returns its stock; refund any payment in Stripe).",
		route: "orders/resolve",
		permission: "plugins:manage",
		destructive: true,
		inputSchema: obj(
			{ id: { type: "string" }, action: { type: "string", enum: ["accept", "release"] } },
			["id", "action"],
		),
	},
	{
		name: "set_stock",
		description:
			"Set the on-hand stock of a product. Pass expectedOnHand, the physical on-hand you last saw (held units included). If it no longer matches, nothing changes and the reply carries the current onHand, held and available: check them and retry with that onHand. Pass the same key when retrying a call that timed out.",
		route: "stock/set",
		permission: "plugins:manage",
		destructive: true,
		inputSchema: obj(
			{
				productId: { type: "string" },
				onHand: { type: "integer", minimum: 0, maximum: 1000000 },
				expectedOnHand: { type: "integer" },
				key: { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" },
			},
			["productId", "onHand", "expectedOnHand"],
		),
	},
	{
		name: "resync_products",
		description:
			"Repair product data from EmDash content (after a lost content hook or a changed products collection). Applies each item's live state with the same rules as the content hooks, so it never rolls a product back, never re-lists an unpublished or deleted one, and never resets stock over sales. Call with no input, then repeat with { phase: nextPhase, cursor: nextCursor } until nextPhase is null. Safe to re-run at any time.",
		route: "products/resync",
		permission: "plugins:manage",
		destructive: true,
		inputSchema: obj({
			phase: { type: "string", enum: ["content", "orphans"] },
			cursor: { type: "string" },
		}),
	},
	{
		name: "export_data",
		description:
			"Export all of Otta Core's data as JSON in pages (products, stock or orders). Pass nextCursor back until it is null. Orders never include the order key or buyer tag.",
		route: "data/export",
		permission: "plugins:manage",
		destructive: false,
		inputSchema: obj(
			{
				kind: { type: "string", enum: ["products", "stock", "orders"] },
				cursor: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 100 },
			},
			["kind"],
		),
	},
] as const;
