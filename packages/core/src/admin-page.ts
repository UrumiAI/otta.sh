/**
 * The admin pages, in Block Kit (a standard-format plugin declares pages in the
 * manifest, never an adminEntry). EmDash renders a page by POSTing a
 * BlockInteraction to this plugin's private `admin` route:
 *   { type: "page_load", page: "/orders" }
 *   { type: "block_action", action_id, value, page }    (button, menu)
 *   { type: "form_submit", action_id, values, page }    (form)
 * and draws the `{ blocks, toast? }` we return (validated host-side).
 *
 * PRESENTATION ONLY. Every write goes through an existing handler (admin.ts
 * ordersFulfil / ordersResolve / stockSet, resync.ts resyncProducts). The only
 * reads added here are `stockView` / `stockList` (product + stock documents,
 * read-only) and health.ts.
 *
 * Bridge calls per interaction (sandbox limit 30):
 *   orders list            1  (ordersList)
 *   order detail           1  (ordersGet)
 *   fulfil                 ordersFulfil (2/attempt, <= 6) + 0; on refusal +1 (ordersGet)
 *   accept / release       ordersResolve (2 + 2t + 1 = 19 at 8 tracked lines) + 0; on refusal +1
 *   stock list             2  (products query + stock getMany)
 *   stock form             2  (product get + stock get)
 *   set stock              stockSet (2, or 3 on STOCK_CHANGED) + 2 (re-read for the form) <= 5
 *   resync step            resyncProducts (meters itself, <= 28) + 0
 *   setup & health         health.ts readHealth (<= 9)
 *
 * Written tersely on purpose: it ships in the registry bundle (50 kB budget).
 */
import type { PluginContext } from "emdash/plugin";
import {
	ordersFulfil,
	ordersGet,
	ordersList,
	ordersResolve,
	STATUSES as ADMIN_STATUSES,
	stockSet,
} from "./admin.js";
import { readHealth, SWEEP_STALE_MS, type Health } from "./health.js";
import { SHOP_ORIGIN_SETTING } from "./settings.js";
import type { OrderDoc, OrderStatus, ProductDoc, StockDoc } from "./model.js";
import { resyncProducts } from "./resync.js";
import { available, held } from "./stock.js";
import { asId, asRecord, coll, minorExponent, randomHex } from "./util.js";

type Block = Record<string, unknown>;
type Toast = { message: string; type: "success" | "error" | "info" };
export interface PageResponse {
	blocks: Block[];
	toast?: Toast;
}
type OrderView = Omit<OrderDoc, "orderKey"> & { id: string };
type Fail = { ok: false; code: string; message: string };

export const ORDERS_PAGE = "/orders";
export const SETUP_PAGE = "/setup";
const STATUSES = ADMIN_STATUSES as OrderStatus[];
const PAGE = 20;
/** Cursors kept for "Previous" (carried in a button value, so bounded). */
const BACK = 20;

// ── tiny builders (plain objects; no runtime dependency) ──
/** Drops undefined keys (JSON drops them anyway), so optional props need no conditional spreads. */
const def = <T extends Block>(o: T): T => {
	for (const k in o) if (o[k] === undefined) delete o[k];
	return o;
};
const blk = (type: string, o: Block = {}): Block => def({ type, ...o });
const header = (text: string) => blk("header", { text });
const section = (text: string) => blk("section", { text });
const divider = blk("divider");
/** labels: "Label,Label,..." matching values by position; a missing value (null / undefined) shows as "—". */
const fields = (labels: string, values: Array<string | null | undefined>) =>
	blk("fields", {
		fields: labels.split(",").map((label, i) => ({ label, value: values[i] ?? "—" })),
	});
const row = (...elements: Block[]) => blk("actions", { elements });
const banner = (variant: string, title: string, description?: string) =>
	blk("banner", { variant, title, description: description || undefined });
const btn = (
	action_id: string,
	label: string,
	value?: unknown,
	style?: string,
	confirm?: Block,
): Block => blk("button", { action_id, label, value, style, confirm });
const ask = (title: string, text: string, confirm: string, style?: string): Block =>
	def({ title, text, confirm, deny: "Cancel", style });
const link = (label: string, path: string) =>
	blk("link", { label, target: { kind: "plugin-page", path } });
const code = (c: string) => blk("code", { code: c });
/** cols: "key:Label:format,..." (format optional). */
const table = (block_id: string, cols: string, rows: unknown[], empty_text?: string) =>
	blk("table", {
		block_id,
		page_action_id: `${block_id}_page`,
		columns: cols.split(",").map((c) => {
			const [key, label, format] = c.split(":");
			return def({ key, label, format });
		}),
		rows,
		empty_text,
	});
const toast = (message: string, type: Toast["type"] = "success"): Toast => ({ message, type });

/** Minor units as "USD 12.34" (null = "—"). */
export function money(n: number | null | undefined, currency: string): string {
	if (n == null) return "—";
	let e = 2;
	try {
		e = minorExponent(currency);
	} catch {}
	return `${currency} ${(n / 10 ** e).toFixed(e)}`;
}

/**
 * Mirrors admin.ts ordersResolve: accept needs a recorded payment, or a fully
 * discounted promo order (a recorded payment of 0 with no PaymentIntent).
 */
export function canAccept(
	o: Pick<OrderDoc, "status" | "promoCodes" | "paidAt" | "amountPaid" | "paymentIntentId">,
): boolean {
	const freePaid = o.promoCodes && o.paidAt !== null && o.amountPaid === 0;
	return (
		o.status === "review" && (freePaid || (o.paymentIntentId !== null && o.amountPaid !== null))
	);
}

type Why = { currency: string; total: number | null; amountPaid?: number | null };
const REFUND: [string, string] = ["Check refunds", "Refunded may be wrong. Check Stripe."];
const LATE = "Paid after it expired or was cancelled; stock not held. Refund if you cannot ship.";
/** Per attention token: [short label, sentence]. $1 = the token's argument, $c = Stripe's charge, $t = order total, $p = amount paid. */
const ATT: Record<string, [string, string]> = {
	AMOUNT_MISMATCH: [
		"Amount differs",
		"Stripe charged $c, total is $t. Accept if fine, else release and refund.",
	],
	PAID_WHILE_EXPIRED: ["Paid late", LATE],
	PAID_WHILE_CANCELED: ["Paid late", LATE],
	FOREIGN_SESSION: ["Unknown session", "Session $1 is not this order's."],
	SESSION_UNREACHABLE: [
		"Session missing",
		"Stripe has no record of this checkout. Release if unpaid.",
	],
	COMPLETE_UNPAID: ["Unpaid in Stripe", 'Stripe says payment is "$1". Release if unpaid.'],
	PAID: ["Review payment", "$p arrived in review. Accept it, or release and refund."],
	OVERSOLD: ["Oversold", "Sold more than in stock. Fix stock or refund."],
	REFUND_CURRENCY: REFUND,
	REFUNDS_TRUNCATED: REFUND,
};

/** A merchant's words for an `attention` value: short labels for the list, sentences for the order. null = not recognised. */
export function attentionWords(
	att: string | null | undefined,
	o: Why,
): { label: string; text: string } | null {
	const cur = att?.match(/ ([A-Z]{3})(?: |$)/)?.[1] ?? o.currency;
	const hit = [...(att ?? "").matchAll(/([A-Z_]{4,})(?::(\S+))?/g)].flatMap(([, k, a]) => {
		const r = ATT[k!];
		const v: Record<string, string> = {
			"1": a ?? "",
			c: a === "?" ? "an unknown amount" : money(+a!, cur),
			t: money(o.total, o.currency),
			p: money(o.amountPaid, o.currency),
		};
		return r ? [{ label: r[0], text: r[1].replace(/\$(.)/g, (_, x) => v[x]!) }] : [];
	});
	return hit.length
		? {
				label: [...new Set(hit.map((h) => h.label))].join(", "),
				text: hit.map((h) => h.text).join(" "),
			}
		: null;
}

/** The handlers answer some failures with one word ("id", "limit"); say what to change. */
const WORDS: Record<string, string> = {
	status: "pending, paid, fulfilled, review, expired or canceled",
	limit: "a whole number, 1 to 50",
	id: "an order id",
	tracking: "up to 200 characters",
};
export const adminMessage = (r: Fail): string =>
	r.code === "BAD_INPUT"
		? WORDS[r.message]
			? `${r.message} must be ${WORDS[r.message]}.`
			: /onHand/.test(r.message)
				? "Enter a whole number, 0 to 1,000,000."
				: r.message
		: r.message;

const isFail = (r: unknown): r is Fail => asRecord(r)["ok"] === false;
const errorOut = (r: Fail, blocks: Block[], m = adminMessage(r)): PageResponse => ({
	blocks: [banner("error", m, r.code), ...blocks],
	toast: toast(m, "error"),
});
const back = btn("list", "Back to orders");
const SETUP_TITLE = "Setup & health";
const toSetup = link(SETUP_TITLE, SETUP_PAGE);
const runResync = btn("resync", "Run resync");
const ordersHead = header("Orders");
const resyncHead = header("Resync products");
const RESYNC_DONE = "Resync complete";

// ── orders list ──

interface ListState {
	s: OrderStatus | null;
	c: string | null;
	/** Cursors of the pages before this one ("" = the first page). */
	b: string[];
}

const str = (v: unknown) => (typeof v === "string" && v.length <= 2000 ? v : null);
function listState(v: unknown): ListState {
	const r = asRecord(v);
	const s = STATUSES.includes(r["s"] as OrderStatus) ? (r["s"] as OrderStatus) : null;
	const b = Array.isArray(r["b"])
		? r["b"].filter((x): x is string => str(x) !== null).slice(-BACK)
		: [];
	return { s, c: str(r["c"]), b };
}

/** Calls: 1. */
export async function renderList(
	ctx: PluginContext,
	st: ListState = { s: null, c: null, b: [] },
): Promise<PageResponse> {
	const r = await ordersList(
		{ limit: PAGE, status: st.s || undefined, cursor: st.c || undefined },
		ctx,
	);
	if (isFail(r)) return errorOut(r, [ordersHead]);
	const review = r.orders.filter((o) => o.status === "review").length;
	const nav: Block[] = [];
	if (st.c !== null)
		nav.push(
			btn("list", "Newest", { s: st.s }),
			btn("list", "Previous", { s: st.s, c: st.b.at(-1) || null, b: st.b.slice(0, -1) }),
		);
	if (r.cursor)
		nav.push(
			btn("list", "Next page", { s: st.s, c: r.cursor, b: [...st.b, st.c ?? ""].slice(-BACK) }),
		);
	return {
		blocks: [
			ordersHead,
			row(
				blk("menu", {
					action_id: "status",
					label: `Status: ${st.s ?? "all"}`,
					items: ["all", ...STATUSES].map((value) => ({ label: value, value })),
				}),
				btn("stock", "Stock"),
				runResync,
				toSetup,
			),
			...(review
				? [
						banner(
							"alert",
							`${review} order${review > 1 ? "s" : ""} on this page need${review > 1 ? "" : "s"} review`,
							"Open each to accept or release it.",
						),
					]
				: []),
			table(
				"orders",
				"id:Order:code,created:Created:relative_time,status:Status:badge,total:Total,attention:Attention,email:Email,open::element",
				r.orders.map((o) => {
					const rv = o.status === "review";
					return {
						id: o.id,
						created: o.createdAt,
						status: rv ? "REVIEW: needs a decision" : o.status,
						total: money(o.total, o.currency),
						attention: attentionWords(o.attention, o)?.label ?? o.attention ?? "",
						email: o.email ?? "",
						open: btn("open", rv ? "Review" : "Open", { id: o.id }, rv ? "primary" : undefined),
					};
				}),
				st.s ? `No ${st.s} orders.` : "No orders yet.",
			),
			...(nav.length ? [row(...nav)] : []),
			// Store setup: free (ctx.plugin and ctx.url are local in the sandbox).
			divider,
			section("Store setup: use the plugin id as PLUGIN_ID in your theme."),
			ids(ctx),
		],
	};
}

const pluginId = (ctx: PluginContext) => ctx.plugin?.id ?? "PLUGIN_ID";
const routeBase = (ctx: PluginContext) => "/_emdash/api/plugins/" + pluginId(ctx);
const ids = (ctx: PluginContext) => fields("Plugin id,Route base", [pluginId(ctx), routeBase(ctx)]);

// ── order detail ──

function addressText(a: Record<string, unknown> | null): string {
	const ad = asRecord(a?.["address"] ?? a);
	return (
		[
			a?.["name"],
			ad["line1"],
			ad["line2"],
			ad["city"],
			ad["state"],
			ad["postal_code"],
			ad["country"],
		]
			.filter((x) => typeof x === "string" && x)
			.join(", ") || "—"
	);
}

export function renderDetail(o: OrderView): Block[] {
	const c = o.currency;
	const m = (n: number | null) => money(n, c);
	const rv = o.status === "review";
	const ok = canAccept(o);
	const out: Block[] = [header(`Order ${o.id}`), row(back, btn("open", "Refresh", { id: o.id }))];
	const why = o.attention ? (attentionWords(o.attention, o)?.text ?? o.attention) : "";
	if (rv)
		out.push(
			banner(
				"alert",
				"Needs a decision",
				`${why ? why + " " : ""}${ok ? "Accept it as a sale, or release it." : "No payment is recorded, so it cannot be accepted: release it."}`,
			),
		);
	else if (o.attention) out.push(banner("alert", "Attention", why));
	out.push(
		fields(
			`Status,Paid at,Email,Shipping address,Attention,Stripe session,Stripe payment${o.fulfilledAt ? ",Fulfilled at,Tracking" : ""}${o.cancelReason ? ",Cancel reason" : ""}`,
			[
				o.status,
				o.paidAt,
				o.email,
				addressText(o.shippingAddress),
				o.attention,
				o.stripeSessionId,
				o.paymentIntentId,
				...(o.fulfilledAt ? [o.fulfilledAt, o.tracking] : []),
				...(o.cancelReason ? [o.cancelReason] : []),
			],
		),
		table(
			"items",
			"title:Item,sku:SKU:code,qty:Qty:number,unit:Unit price,line:Line total,stock::element",
			o.items.map((i) => ({
				title: i.title,
				sku: i.sku ?? "",
				qty: i.qty,
				unit: m(i.unitPrice),
				line: m(i.unitPrice * i.qty),
				stock: i.trackStock ? btn("stock_edit", "Stock", { productId: i.productId }) : null,
			})),
		),
		fields(
			"Subtotal,Shipping,Total,Discount,Amount paid,Refunded",
			[o.subtotal, o.shipping, o.total, o.discount, o.amountPaid, o.refundedAmount].map((v, i) =>
				// A 100%-off promotion code: no money came in, so there is nothing to refund.
				i === 4 && v === 0 && o.paidAt !== null ? `${m(0)}: free order (promotion code)` : m(v),
			),
		),
	);
	if (o.status === "paid")
		out.push(
			blk("form", {
				block_id: "fulfil",
				fields: [
					{ type: "text_input", action_id: "tracking", label: "Tracking reference (optional)" },
				],
				submit: { label: "Mark fulfilled", action_id: `fulfil:${o.id}` },
			}),
		);
	if (rv)
		out.push(
			row(
				...(ok
					? [
							btn(
								"resolve",
								"Accept as a sale",
								{ id: o.id, action: "accept" },
								"primary",
								ask("Accept?", "It becomes a paid sale; stock is committed.", "Accept"),
							),
						]
					: []),
				btn(
					"resolve",
					"Release",
					{ id: o.id, action: "release" },
					"danger",
					ask("Release?", "It is canceled; stock returns. Refund in Stripe.", "Release", "danger"),
				),
			),
		);
	return out;
}

/** Calls: 1. */
async function openOrder(ctx: PluginContext, id: unknown): Promise<PageResponse> {
	const r = await ordersGet({ id }, ctx);
	return isFail(r) ? errorOut(r, [row(back)]) : { blocks: renderDetail(r.order as OrderView) };
}

// ── stock (read-only helpers; writes go through stockSet) ──

export interface StockView {
	productId: string;
	title: string;
	trackStock: boolean;
	onHand: number;
	held: number;
	available: number;
}

const toView = (productId: string, p: ProductDoc | null, d: StockDoc | null): StockView => ({
	productId,
	title: p?.title ?? productId,
	trackStock: p?.trackStock ?? d !== null,
	onHand: d?.onHand ?? 0,
	held: d ? held(d) : 0,
	available: available(d),
});

/** Read-only, one product. Calls: 2 (product get + stock get). */
export async function stockView(ctx: PluginContext, productId: string): Promise<StockView> {
	const p = await coll<ProductDoc>(ctx, "products").get(productId);
	return toView(productId, p, await coll<StockDoc>(ctx, "stock").get(productId));
}

/** Read-only, a page of products. Calls: 2 (products query + stock getMany). */
export async function stockList(
	ctx: PluginContext,
	cursor: string | null,
): Promise<{ items: StockView[]; cursor: string | null }> {
	const r = await coll<ProductDoc>(ctx, "products").query({
		limit: PAGE,
		...(cursor ? { cursor } : {}),
	});
	const docs = await coll<StockDoc>(ctx, "stock").getMany(
		r.items.filter((i) => i.data.trackStock).map((i) => i.id),
	);
	return {
		items: r.items.map((i) => toView(i.id, i.data, docs.get(i.id) ?? null)),
		cursor: r.hasMore && r.cursor ? r.cursor : null,
	};
}

async function renderStock(ctx: PluginContext, cursor: string | null): Promise<PageResponse> {
	const r = await stockList(ctx, cursor);
	return {
		blocks: [
			header("Stock"),
			row(
				back,
				...(cursor ? [btn("stock", "First page")] : []),
				...(r.cursor ? [btn("stock", "Next page", { c: r.cursor })] : []),
			),
			table(
				"stock",
				"title:Product,onHand:On hand (held included),held:Held,available:Available,set::element",
				r.items.map((v) => ({
					title: v.title,
					onHand: v.trackStock ? String(v.onHand) : "unlimited",
					held: v.trackStock ? String(v.held) : "",
					available: v.trackStock ? String(v.available) : "",
					set: btn("stock_edit", "Set stock", { productId: v.productId }),
				})),
				"No products yet. Publish products in your products collection; they appear here when published.",
			),
		],
	};
}

/** expectedOnHand = the on-hand shown; the key makes a double submit a no-op. Both ride in the action id. */
const stockForm = (v: StockView): Block[] => [
	header(`Stock: ${v.title}`),
	row(btn("stock", "All stock"), back),
	fields("Product,On hand,Held,Available", [
		v.productId,
		...[v.onHand, v.held, v.available].map(String),
	]),
	blk("form", {
		block_id: "stock_set",
		fields: [
			{
				type: "number_input",
				action_id: "onHand",
				label: "New on hand (held units included)",
				initial_value: v.onHand,
				min: 0,
				max: 1e6,
			},
		],
		submit: {
			label: "Set stock",
			action_id: `stock_set:${v.productId}:${v.onHand}:${randomHex(8)}`,
		},
	}),
];

async function setStock(
	ctx: PluginContext,
	actionId: string,
	values: Record<string, unknown>,
): Promise<PageResponse> {
	const [, productId, expectedOnHand, key] = actionId.split(":");
	const r = await stockSet({ productId, onHand: values["onHand"], expectedOnHand, key }, ctx);
	const pid = asId(productId);
	if (!pid) return errorOut(r as Fail, []);
	const v = await stockView(ctx, pid);
	return isFail(r)
		? errorOut(r, stockForm(v))
		: {
				blocks: stockForm(v),
				toast: toast(`Stock set: ${v.onHand} on hand, ${v.available} available`),
			};
}

// ── resync: one resyncProducts call per click (it meters itself); progress rides in the button ──

async function resync(ctx: PluginContext, value: unknown): Promise<PageResponse> {
	const v = asRecord(value);
	const n = (k: string) => (Number.isInteger(v[k]) ? (v[k] as number) : 0);
	const phase = v["phase"] === "orphans" ? "orphans" : "content";
	const cursor = str(v["cursor"]);
	const r = await resyncProducts({ phase, ...(cursor ? { cursor } : {}) }, ctx);
	const nav = row(back, toSetup);
	if (isFail(r)) return errorOut(r, [resyncHead, row(btn("resync", "Retry", value)), nav]);
	const t = {
		synced: n("synced") + r.synced,
		deactivated: n("deactivated") + r.deactivated,
		steps: n("steps") + 1,
	};
	const done = r.nextPhase === null;
	return {
		blocks: [
			resyncHead,
			banner(
				done ? "default" : "alert",
				done ? RESYNC_DONE : "Not finished. Press Continue until it says complete.",
			),
			fields(
				"Products updated,Taken off sale,Steps",
				[t.synced, t.deactivated, t.steps].map(String),
			),
			...(done
				? []
				: [
						row(
							btn(
								"resync",
								"Continue",
								{ phase: r.nextPhase, cursor: r.nextCursor, ...t },
								"primary",
							),
						),
					]),
			nav,
		],
		...(done ? { toast: toast(RESYNC_DONE) } : {}),
	};
}

// ── setup & health ──

/** The Stripe events the webhook endpoint needs, one per line (copy-ready). */
const WEBHOOK_EVENTS =
	"checkout.session.completed\ncheckout.session.expired\nrefund.created\nrefund.updated\nrefund.failed";
type Check = { check: string; status: "PASS" | "FIX" | "WAIT"; detail: string };

export function healthChecks(h: Health, now = Date.now()): Check[] {
	const s = h.settings;
	const pr = h.products;
	const p = h.keyProbe;
	const plus = pr.complete ? "" : "+";
	const age = h.lastSweep ? now - Date.parse(h.lastSweep) : Infinity;
	const list: Array<[string, boolean | "WAIT", string] | false> = [
		s.stripeSecretKey === null
			? ["Stripe key", false, "Enter the Stripe secret key in the plugin settings."]
			: [
					"Stripe key",
					h.keyMode !== "unknown",
					h.keyMode === "unknown"
						? "Not an sk_ or rk_ key: paste the secret key from Stripe."
						: `Present, ${h.keyMode} mode.`,
				],
		p !== null && [
			"Accepted by Stripe",
			p.probe === "accepted",
			p.probe === "accepted"
				? "Stripe accepted the key."
				: p.probe === "rejected"
					? "Stripe rejected the key (401): paste a current key."
					: p.probe === "forbidden"
						? "The key lacks the Checkout Sessions permission (403): grant it, or use the secret key."
						: `Could not reach Stripe (${p.status ?? "no connection"}). Re-check soon.`,
		],
		[
			"Webhook secret",
			s.stripeWebhookSecret !== null,
			s.stripeWebhookSecret !== null
				? "Present."
				: "Paste the endpoint's signing secret (whsec_) into the settings.",
		],
		[
			"Last verified webhook",
			// Expected on a fresh install (the first test payment turns it green): WAIT, not a fix.
			h.lastWebhook !== null ? true : "WAIT",
			h.lastWebhook ??
				"None yet. This turns green after your first test payment; until then orders still settle, up to 5 minutes late.",
		],
		[
			"Products collection",
			pr.active > 0,
			!pr.total
				? `No products synced from "${s.productsCollection}" yet. Publish a product in that collection; it syncs when published. (If the name is wrong, fix the setting.)`
				: `"${s.productsCollection}": ${pr.total} synced, ${pr.active}${plus} for sale, ${pr.inactive}${plus} not for sale${plus && ` (first ${pr.checked} checked)`}.`,
		],
		[
			"Shop address",
			true,
			s.shopOrigin
				? `${s.shopOrigin} (where buyers return after paying, unless your URLs are absolute).`
				: "Recorded the first time you open this page.",
		],
		s.currencyValid && [
			"Flat shipping",
			true,
			`${money(s.flatShipping, s.currency)} per order (the setting is in the smallest unit: 500 means 5.00).`,
		],
		["Currency", s.currencyValid, s.currencyValid ? s.currency : (s.problem ?? "")],
		s.problem !== null && s.currencyValid && ["Settings", false, s.problem],
		h.cardProblem !== null && [
			"Card payments",
			false,
			`Stripe would not offer card payment for an order (last ${h.cardProblem}). Check that Cards are turned on in your Stripe Dashboard (Settings → Payment methods).`,
		],
		[
			"Sweep",
			// Never run yet is expected right after install: WAIT, not a fix.
			age <= SWEEP_STALE_MS ? true : h.lastSweep ? false : "WAIT",
			age <= SWEEP_STALE_MS
				? `Last run ${h.lastSweep} (${Math.max(0, Math.round(age / 60_000))} min ago).`
				: h.lastSweep
					? "Cleanup has not run for over 15 minutes: check your site's cron trigger."
					: "Not run yet. It starts within a few minutes of install; if this stays, check your site's cron trigger.",
		],
	];
	return list
		.filter((x) => x !== false)
		.map(([check, ok, detail]) => ({
			check,
			status: ok === "WAIT" ? "WAIT" : ok ? "PASS" : "FIX",
			detail,
		}));
}

/** README.md's buy-button snippet (the storefront kit's), with this install's route base filled in. */
const buySnippet = (
	base: string,
) => `<button type="button" data-otta-buy="PRODUCT_CONTENT_ID">Buy</button>
<p data-otta-msg role="status"></p>
<script is:inline type="module">
import { createCart, buyerMessage } from "/otta/cart.js";
const cart = createCart({ api: "${base}" });
for (const btn of document.querySelectorAll("[data-otta-buy]")) {
	if (btn.dataset.ottaReady) continue;
	btn.dataset.ottaReady = "1";
	btn.addEventListener("click", async () => {
		const msg = btn.parentElement.querySelector("[data-otta-msg]");
		btn.disabled = true;
		if (msg) msg.textContent = "";
		const out = await cart.checkout({ lines: [{ productId: btn.dataset.ottaBuy, qty: 1 }] });
		if (out.ok) return location.assign(out.url);
		if (msg) msg.textContent = buyerMessage(out.code);
		btn.disabled = false;
	});
}
</script>`;

/** Calls: readHealth (<= 9). */
export async function renderSetup(
	ctx: PluginContext,
	now = Date.now(),
	origin: string | null = null,
): Promise<PageResponse> {
	const h = await readHealth(ctx);
	// Record the shop's address from this authenticated admin request, once (see
	// checkout absolute()). The settings read above already says whether one exists.
	if (h.settings.shopOrigin === null && origin !== null) {
		try {
			await ctx.kv.set(`settings:${SHOP_ORIGIN_SETTING}`, origin);
			h.settings.shopOrigin = origin;
		} catch {}
	}
	const checks = healthChecks(h, now);
	const base = routeBase(ctx);
	const fixes = checks.filter((c) => c.status === "FIX").length;
	return {
		blocks: [
			header(SETUP_TITLE),
			row(
				btn("setup", "Re-check"),
				runResync,
				link("Orders", ORDERS_PAGE),
				blk("link", { label: "Plugin settings", target: { kind: "plugin-settings" } }),
			),
			fixes ? banner("alert", `${fixes} to fix`) : banner("default", "All checks pass"),
			table("checks", "check:Check,status:Result:badge,detail:Detail or fix", checks),
			...(origin && origin !== h.settings.shopOrigin
				? [
						row(
							btn(
								"shop_origin_here",
								`Use ${origin} as the shop address`,
								undefined,
								undefined,
								ask(
									"Change the shop address?",
									"Buyers return here after paying (unless your URLs are absolute).",
									"Change",
								),
							),
						),
					]
				: []),
			divider,
			section("Copy-ready values"),
			ids(ctx),
			section("Stripe webhook endpoint URL"),
			code(
				`${(ctx as { site?: { url?: string } }).site?.url?.replace(/\/$/, "") || origin || ""}${base}/stripe/webhook`,
			),
			section("Webhook events"),
			code(WEBHOOK_EVENTS),
			section("Buy button (replace PRODUCT_CONTENT_ID)"),
			code(buySnippet(base)),
		],
	};
}

// ── dispatcher: the private `admin` route ──

export async function adminPage(
	input: unknown,
	ctx: PluginContext,
	origin: string | null = null,
): Promise<PageResponse> {
	const i = asRecord(input);
	const id = typeof i["action_id"] === "string" ? i["action_id"] : "";
	const value = i["value"];
	const v = asRecord(value);
	const values = asRecord(i["values"]);
	const setup = i["page"] === SETUP_PAGE;
	if (i["type"] === "page_load")
		return setup ? renderSetup(ctx, Date.now(), origin) : renderList(ctx);
	if (i["type"] !== "block_action" && i["type"] !== "form_submit") return { blocks: [] };
	if (id === "list") return renderList(ctx, listState(value));
	if (id === "status") return renderList(ctx, listState({ s: value }));
	if (id === "open") return openOrder(ctx, v["id"]);
	if (id.startsWith("fulfil:")) {
		const oid = id.slice(7);
		const t = typeof values["tracking"] === "string" ? values["tracking"].trim() : "";
		const r = await ordersFulfil({ id: oid, tracking: t || null }, ctx);
		return isFail(r)
			? errorOut(r, (await openOrder(ctx, oid)).blocks)
			: { blocks: renderDetail(r.order as OrderView), toast: toast("Marked fulfilled") };
	}
	if (id === "resolve") {
		const r = await ordersResolve({ id: v["id"], action: v["action"] }, ctx);
		if (isFail(r)) return errorOut(r, (await openOrder(ctx, v["id"])).blocks);
		return {
			blocks: renderDetail(r.order as OrderView),
			toast: toast(
				v["action"] === "accept" ? "Accepted as a sale" : "Released: refund any payment in Stripe",
			),
		};
	}
	if (id === "shop_origin_here") {
		// An authenticated admin's own address replaces the recorded one (e.g. after a
		// first visit on a preview host).
		if (origin !== null) await ctx.kv.set(`settings:${SHOP_ORIGIN_SETTING}`, origin);
		return renderSetup(ctx, Date.now(), origin);
	}
	if (id === "stock") return renderStock(ctx, str(v["c"]));
	if (id === "stock_edit") {
		const pid = asId(v["productId"]);
		return pid ? { blocks: stockForm(await stockView(ctx, pid)) } : renderStock(ctx, null);
	}
	if (id.startsWith("stock_set:")) return setStock(ctx, id, values);
	if (id === "resync") return resync(ctx, value);
	// "setup" (Re-check), or anything else (a table sort, a stale button): the page it came from.
	return setup || id === "setup" ? renderSetup(ctx, Date.now(), origin) : renderList(ctx);
}
