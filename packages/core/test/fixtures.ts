/**
 * Flow-test fixtures: a small fake Stripe on the harness http fake, a signed
 * webhook builder, product seeding through the real sync hooks, and an
 * invariant checker for stock/order consistency.
 */
import type { PluginContext } from "emdash/plugin";
import plugin from "../src/plugin.js";
import { onAfterPublish, onAfterSave } from "../src/products.js";
import type { OrderDoc, StockDoc } from "../src/model.js";
import { createTestContext, type HostDb } from "./harness.js";

export type Harness = Awaited<ReturnType<typeof createTestContext>>;

export const SECRET = "sk_test_flow";
export const WHSEC = "whsec_flow";
const BASE = "https://api.stripe.com/v1/checkout/sessions";

export interface FakeSession {
	id: string;
	object: "checkout.session";
	url: string;
	status: "open" | "complete" | "expired";
	payment_status: "paid" | "unpaid" | "no_payment_required";
	amount_total: number;
	currency: string;
	payment_intent: string | null;
	customer_details: { email: string } | null;
	metadata: Record<string, string>;
	expires_at: number;
	created?: number;
	payment_method_types?: string[];
	[k: string]: unknown;
}

export interface FakeStripe {
	sessions: Map<string, FakeSession>;
	byIdem: Map<string, string>;
	/** One entry per create request actually received (including replays). */
	creates: Array<{ idem: string | undefined; params: URLSearchParams; deduped: boolean }>;
	expireCalls: string[];
	/** Make the next create fail with this status (once). */
	failNextCreate(status: number): void;
	complete(id: string, over?: Partial<FakeSession>): FakeSession;
	expire(id: string): FakeSession;
	/** The only session (most tests have one). */
	only(): FakeSession;
	forOrder(orderId: string): FakeSession | undefined;
	event(
		type: "checkout.session.completed" | "checkout.session.expired",
		id: string,
	): Promise<{ body: Uint8Array; sig: string }>;
	/** Serve this same fake Stripe (shared state) to another harness. */
	attach(h: Harness): void;
}

const sumLines = (p: URLSearchParams) => {
	let total = 0;
	for (let i = 0; p.has(`line_items[${i}][quantity]`); i++)
		total +=
			Number(p.get(`line_items[${i}][quantity]`)) *
			Number(p.get(`line_items[${i}][price_data][unit_amount]`));
	total += Number(p.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") ?? 0);
	return total;
};

const err = (status: number, message: string) => ({ status, json: { error: { message } } });

export function installFakeStripe(h: Harness): FakeStripe {
	const sessions = new Map<string, FakeSession>();
	const byIdem = new Map<string, string>();
	const creates: FakeStripe["creates"] = [];
	const expireCalls: string[] = [];
	let failCreate: number | null = null;
	let seq = 0;

	const handler = (req: {
		url: string;
		method: string;
		headers: Record<string, string>;
		body: string;
	}) => {
		const path = req.url.slice(BASE.length);
		if (req.method === "POST" && path === "") {
			const idem = req.headers["idempotency-key"];
			const params = new URLSearchParams(req.body);
			if (failCreate !== null) {
				const s = failCreate;
				failCreate = null;
				creates.push({ idem, params, deduped: false });
				return err(s, "boom");
			}
			// Real Stripe (API 2026-09-30 and later) refuses this parameter on Checkout.
			if (params.has("payment_method_types[0]"))
				return err(
					400,
					"The `payment_method_types` parameter is no longer supported when creating a Checkout Session.",
				);
			const prior = idem ? byIdem.get(idem) : undefined;
			creates.push({ idem, params, deduped: prior !== undefined });
			if (prior) return { json: sessions.get(prior) };
			const id = `cs_test_${++seq}`;
			const s: FakeSession = {
				id,
				object: "checkout.session",
				url: `https://checkout.stripe.test/${id}`,
				status: "open",
				payment_status: "unpaid",
				amount_total: sumLines(params),
				currency: params.get("line_items[0][price_data][currency]") ?? "usd",
				payment_intent: null,
				customer_details: null,
				metadata: {
					order_id: params.get("metadata[order_id]") ?? "",
					otta_store: params.get("metadata[otta_store]") ?? "",
				},
				expires_at: Number(params.get("expires_at")),
				created: Math.floor(Date.now() / 1000),
				payment_method_types: params.has("allowed_payment_method_types[0]")
					? [params.get("allowed_payment_method_types[0]")!]
					: ["card", "klarna"],
			};
			sessions.set(id, s);
			if (idem) byIdem.set(idem, id);
			return { json: s };
		}
		if (req.method === "GET" && path.startsWith("?")) {
			// List (sweep part E): ?status=…&created[gte]=…&limit=…, newest first.
			// Like Stripe: newest first, status and created[gte] filters, limit, starting_after.
			const q = new URLSearchParams(path.slice(1));
			const st = q.get("status");
			const gte = Number(q.get("created[gte]") ?? 0);
			const limit = Number(q.get("limit") ?? 10);
			let all = [...sessions.values()]
				.filter((x) => (st === null || x.status === st) && (x.created ?? 0) >= gte)
				.toSorted((x, y) => (y.created ?? 0) - (x.created ?? 0) || (y.id < x.id ? -1 : 1));
			const after = q.get("starting_after");
			if (after) all = all.slice(all.findIndex((x) => x.id === after) + 1);
			return { json: { object: "list", data: all.slice(0, limit), has_more: all.length > limit } };
		}
		const m = /^\/([^/]+)(\/expire)?$/.exec(path);
		const s = m ? sessions.get(decodeURIComponent(m[1]!)) : undefined;
		if (!m || !s) return err(404, "No such checkout.session");
		if (req.method === "GET" && !m[2]) return { json: s };
		if (req.method === "POST" && m[2]) {
			expireCalls.push(s.id);
			if (s.status !== "open")
				return err(400, `Only Checkout Sessions with a status of open can be expired.`);
			s.status = "expired";
			return { json: s };
		}
		return err(405, "method");
	};
	h.http.on("*", BASE, handler);

	const enc = new TextEncoder();
	const sign = async (t: number, body: string) => {
		const k = await crypto.subtle.importKey(
			"raw",
			enc.encode(WHSEC),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign("HMAC", k, enc.encode(`${t}.${body}`));
		return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
	};

	return {
		sessions,
		byIdem,
		creates,
		expireCalls,
		failNextCreate: (s) => void (failCreate = s),
		complete(id, over = {}) {
			const s = sessions.get(id)!;
			s.status = "complete";
			s.payment_status = "paid";
			s.payment_intent = `pi_${id}`;
			s.customer_details = { email: "buyer@example.com" };
			Object.assign(s, over);
			return s;
		},
		expire(id) {
			const s = sessions.get(id)!;
			s.status = "expired";
			return s;
		},
		only() {
			if (sessions.size !== 1) throw new Error(`expected 1 session, have ${sessions.size}`);
			return [...sessions.values()][0]!;
		},
		attach: (other) => other.http.on("*", BASE, handler),
		forOrder: (orderId) => [...sessions.values()].find((s) => s.metadata["order_id"] === orderId),
		async event(type, id) {
			const text = JSON.stringify({ id: `evt_${++seq}`, type, data: { object: sessions.get(id) } });
			const t = Math.floor(Date.now() / 1000);
			return { body: enc.encode(text), sig: `t=${t},v1=${await sign(t, text)}` };
		},
	};
}

/** Drive the PUBLIC webhook route handler; returns status and parsed JSON. */
export async function deliver(
	ctx: PluginContext,
	e: { body: Uint8Array; sig?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
	const route = (
		plugin.routes as Record<string, { handler: (r: unknown, c: PluginContext) => Promise<unknown> }>
	)["stripe/webhook"]!;
	const out = (await route.handler(
		{
			input: e.body,
			request: {
				url: "https://shop.test/_emdash/api/plugins/otta/stripe/webhook",
				method: "POST",
				headers: e.sig === undefined ? {} : { "stripe-signature": e.sig },
			},
		},
		ctx,
	)) as { status: number; body: { kind: string; value: string } };
	return { status: out.status, json: JSON.parse(out.body.value) as Record<string, unknown> };
}

export async function callRoute(ctx: PluginContext, name: string, input: unknown): Promise<any> {
	const route = (
		plugin.routes as Record<string, { handler: (r: unknown, c: PluginContext) => Promise<unknown> }>
	)[name]!;
	// The storefront always sends the checkout header (plugin.ts CHECKOUT_HEADER).
	return route.handler(
		{
			input,
			request: { url: "https://shop.test/x", method: "POST", headers: { "x-otta-checkout": "1" } },
		},
		ctx,
	);
}

export const orderKey = (n: number) => `ord_${n.toString(16).padStart(32, "0")}`;

export interface ProductSeed {
	id: string;
	price: number; // major units
	stock?: number | null; // null/undefined = untracked
	title?: string;
}

export interface Shop extends Harness {
	stripe: FakeStripe;
	order(id: string): Promise<OrderDoc>;
	stock(pid: string): Promise<StockDoc>;
	/** Distinct tracked products p1..pn, stock `stock` each, price 10.00. */
	allStock(): Promise<StockDoc[]>;
}

export interface ShopOptions {
	secrets?: boolean;
	shipping?: number;
	/** Share this (migrated) database instead of a fresh one; the caller owns it. */
	db?: HostDb;
}

const shopSettings = (o: ShopOptions) => ({
	stripeSecretKey: SECRET,
	...(o.secrets === false ? {} : { stripeWebhookSecret: WHSEC }),
	currency: "USD",
	flatShipping: o.shipping ?? 500,
	// An installed store: the install hook has created its secret.
	_ipSalt: "5a17".repeat(16),
});

export async function makeShop(products: ProductSeed[], o: ShopOptions = {}): Promise<Shop> {
	const h = await createTestContext(o.db ? { db: o.db } : {});
	const stripe = installFakeStripe(h);
	h.kv.seedSettings(shopSettings(o));
	for (const p of products) await publish(h.ctx, p);
	h.resetCalls();
	h.http.clear();
	return withShop(h, stripe);
}

/**
 * Another context on the same shop: its own storage over `db` (e.g. a separate
 * Postgres pool from TestDb.connect()), the same settings and the same fake
 * Stripe. Nothing is seeded; products come from the first shop.
 */
export async function joinShop(base: Shop, db: HostDb, o: ShopOptions = {}): Promise<Shop> {
	const h = await createTestContext({ db });
	base.stripe.attach(h);
	h.kv.seedSettings(shopSettings(o));
	return withShop(h, base.stripe);
}

function withShop(h: Harness, stripe: FakeStripe): Shop {
	return {
		...h,
		stripe,
		order: async (id) => (await h.raw("orders").get(id)) as OrderDoc,
		stock: async (pid) => (await h.raw("stock").get(pid)) as StockDoc,
		allStock: async () => {
			const r = await h.raw("stock").query({ limit: 100 });
			return r.items.map((i) => i.data as StockDoc);
		},
	};
}

/** Content updatedAt as EmDash sends it: an ISO timestamp, strictly increasing. */
let clock = Date.parse("2026-11-21T00:00:00.000Z");
export const nextUpdatedAt = () => new Date((clock += 1000)).toISOString();

export async function publish(
	ctx: PluginContext,
	p: ProductSeed,
	hook: "publish" | "save" = "publish",
) {
	const content = {
		id: p.id,
		status: "published",
		updatedAt: nextUpdatedAt(),
		data: {
			title: p.title ?? `Product ${p.id}`,
			price: p.price,
			...(p.stock == null ? {} : { stock: p.stock }),
		},
	};
	const ev = { content, collection: "products" };
	if (hook === "publish") await onAfterPublish(ev, ctx);
	else await onAfterSave(ev, ctx);
}

/** n distinct tracked products p1..pn at 10.00 each with `stock` units. */
export const nProducts = (n: number, stock = 5): ProductSeed[] =>
	Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, price: 10, stock }));
export const linesFor = (n: number, qty = 1) =>
	Array.from({ length: n }, (_, i) => ({ productId: `p${i + 1}`, qty }));

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

/**
 * Global consistency: every hold belongs to a live order that still owns it
 * (pending or review, stock reserving/held), nothing is held by a closed
 * order, and sold units match committed orders. Returns problems (empty = ok).
 */
export async function invariants(s: Shop, initial: Record<string, number>): Promise<string[]> {
	const problems: string[] = [];
	const ords = (await s.raw("orders").query({ limit: 200 })).items.map((i) => ({
		id: i.id,
		d: i.data as OrderDoc,
	}));
	const stocks = await s.allStock();
	const holdsOf = (id: string) => stocks.reduce((a, st) => a + (st.holds[id] ?? 0), 0);
	for (const st of stocks)
		for (const id of Object.keys(st.holds)) {
			const o = ords.find((x) => x.id === id)?.d;
			if (!o) problems.push(`hold ${id} on ${st.productId} has no order`);
			else if (
				!["pending", "review"].includes(o.status) ||
				!["reserving", "held"].includes(o.stock)
			)
				problems.push(`hold ${id} on ${st.productId} leaked: order ${o.status}/${o.stock}`);
		}
	for (const { id, d } of ords) {
		if (d.status === "paid" || d.status === "fulfilled") {
			if (d.stock !== "committed") problems.push(`${id} ${d.status} but stock ${d.stock}`);
		}
		if (d.status === "expired" || d.status === "canceled") {
			if (d.stock === "committed") problems.push(`${id} ${d.status} but committed`);
			if (holdsOf(id) !== 0) problems.push(`${id} ${d.status} still holds`);
		}
		if ((d.stock === "committed" || d.stock === "released") && d.stockPending !== 0)
			problems.push(`${id} flag set`);
	}
	for (const st of stocks) {
		const sold = ords
			.filter(({ d }) => d.stock === "committed")
			.flatMap(({ d }) => d.items.filter((i) => i.productId === st.productId && i.trackStock))
			.reduce((a, i) => a + i.qty, 0);
		const want = (initial[st.productId] ?? 0) - sold;
		if (st.onHand !== want) problems.push(`${st.productId} onHand ${st.onHand} != ${want}`);
		if (sum(st.holds) < 0) problems.push("negative holds");
	}
	return problems;
}
