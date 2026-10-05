/**
 * Give a LOCAL e2e stack paid orders, so the admin Orders specs have rows to
 * click, ids to copy and money to (not) refund (issue #378).
 *
 * WHY THIS SCRIPT EXISTS. On a fresh stack the orders-console specs failed with
 * "the stack has no orders": nothing ever placed one. `seed-demo-commerce.ts`
 * prices the catalog; this script, which runs after it, buys from it. It
 * replaces `capture-e2e-payments.ts`, which signed webhooks against the
 * standalone commerce service (`COMMERCE_SERVICE_URL` / `INTERNAL_API_TOKEN`)
 * that INC-D3b deleted.
 *
 * HOW AN ORDER GETS PAID WITHOUT STRIPE. Commerce refuses to create an order
 * with no payment gateway, and the real gateway needs a Stripe account. So the
 * dev server must be started with `OTTA_E2E_STRIPE_OFFLINE=1`
 * (`src/lib/e2e-stripe-offline.ts`). Under `astro dev`, and only there, that
 * arms the plugin's offline gateway: a webhook secret alone, an unpayable
 * `pi_<orderId>` handle, no network. Each order then goes through the SAME
 * doors a shopper's does:
 *
 *   1. the public storefront routes: create a cart, add a line, place it;
 *   2. the site's own `POST /webhooks/stripe` with a `payment_intent.succeeded`
 *      signed by `signStripeWebhook`, the helper the contract tests use. The
 *      plugin verifies the HMAC and the freshness window exactly as it would for
 *      Stripe, and `settleOrder` marks the order paid and captures its total.
 *
 * Nothing is written to a database directly, and nothing is faked past the
 * signature.
 *
 * SAFE BY CONSTRUCTION.
 *  - LOOPBACK ONLY. `SITE_URL` must name 127.0.0.1, localhost or ::1, or the
 *    script refuses before its first request. It signs payment webhooks, so
 *    aiming it at a real store is the failure to prevent.
 *  - NEVER WITH A REAL STRIPE KEY. If the store has a Stripe secret key, its
 *    orders create real PaymentIntents and a synthetic success would record
 *    money that does not exist. The script reads the Settings page and refuses.
 *  - THE WEBHOOK SECRET IS OVERWRITTEN with `whsec_e2e_offline` (or
 *    `STRIPE_WEBHOOK_SECRET`). That is safe for the same reason: a store with
 *    no secret key cannot take a real card payment, so no real webhook depends
 *    on the secret it had.
 *
 * RE-RUNNING IS SAFE. It counts the store's paid orders first and places only
 * the shortfall up to `OTTA_E2E_PAID_ORDERS` (default 2). A second run against a
 * seeded stack does nothing.
 *
 * USAGE (after the site's seed and `seed-demo-commerce.ts`, against a dev
 * server started with OTTA_E2E_STRIPE_OFFLINE=1):
 *
 *   SITE_URL=http://127.0.0.1:4500 pnpm dlx tsx@4 sites/staging/scripts/seed-e2e-orders.ts
 *
 * The e2e harness's global setup runs it for you under `OTTA_E2E_SEED=1`.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	checkoutIdempotencyKey,
	CONSOLE_READ_INTERACTION,
	OTTA_PLUGIN_ID,
	PRODUCTS_CONSOLE_RESOURCE_PREFIX,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
} from "@otta-sh/plugin";
import { signStripeWebhook } from "@otta-sh/payments-stripe";
import { cmsAuthHeaders } from "./seed-demo-commerce.js";

/** The webhook secret the seed provisions and signs with. A placeholder: it
 *  only ever authenticates this script to a local dev server. */
export const E2E_WEBHOOK_SECRET = "whsec_e2e_offline";

/** How many paid orders a seeded stack has. Two: the orders specs need one
 *  row with money left to refund, and a second keeps "the first row" from being
 *  the only row. */
export const DEFAULT_PAID_ORDERS = 2;

/** The buyer every seeded order is placed for. `.test` is reserved (RFC 2606),
 *  so no mail to it can reach anyone even on a stack that has email. */
export const E2E_BUYER = "e2e-orders@example.test";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Refuse anything but a loopback site, before any request is made. */
export function assertLoopbackSite(raw: string): string {
	let host: string;
	try {
		host = new URL(raw).hostname;
	} catch {
		throw new Error(`SITE_URL must be a URL, got ${raw}`);
	}
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(
			`SITE_URL must point at loopback, got ${host} (from ${raw}). This script signs ` +
				`payment webhooks and must never be aimed at a real store.`,
		);
	}
	return raw.replace(/\/+$/, "");
}

/** A catalog row as the products console reads it — only what this script
 *  reasons about. */
export interface CatalogRow {
	productId: string;
	sku: string | null;
	priceCents: number | null;
	currency: string | null;
	active: boolean;
	onHand: number | null;
	deletedAt: string | null;
}

/** A product a shopper could buy right now: priced, active, live and in stock. */
export interface Purchasable {
	productId: string;
	sku: string;
	currency: string;
}

/** The first product a cart can actually hold, or `null` for none. Every
 *  condition matters: an unpriced line cannot be placed (`PRODUCT_NOT_PRICED`)
 *  and an out-of-stock one cannot be added. */
export function pickPurchasable(rows: readonly CatalogRow[]): Purchasable | null {
	for (const row of rows) {
		if (
			row.sku !== null &&
			row.active &&
			row.deletedAt === null &&
			row.priceCents !== null &&
			row.priceCents > 0 &&
			row.currency !== null &&
			row.onHand !== null &&
			row.onHand > 0
		) {
			return { productId: row.productId, sku: row.sku, currency: row.currency };
		}
	}
	return null;
}

/**
 * Does the store hold a Stripe secret key? Read off the Settings page's own
 * field label ("Stripe secret key — set" / "— not set"), the only place the
 * fact is exposed: the key itself is write-only and never rendered.
 *
 * An unreadable page is a refusal, not a "no": guessing "not set" on a shape
 * this script does not recognise is how it would sign a fake payment against a
 * live store.
 */
export function stripeSecretKeyIsSet(settingsPage: unknown): boolean {
	const labels: string[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (node === null || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record["action_id"] === "stripeSecretKey" && typeof record["label"] === "string") {
			labels.push(record["label"]);
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(settingsPage);
	const label = labels[0];
	if (labels.length !== 1 || label === undefined) {
		throw new Error(
			`could not find exactly one "Stripe secret key" field on the Settings page (found ` +
				`${String(labels.length)}). Refusing to guess whether this store takes real payments.`,
		);
	}
	if (label.endsWith("— not set")) return false;
	if (label.endsWith("— set")) return true;
	throw new Error(`unrecognised Stripe secret key label "${label}". Refusing to guess.`);
}

export interface SeedOrdersDeps {
	siteUrl: string;
	/** The admin credential (`cmsAuthHeaders`): reads and settings writes. */
	authHeaders: Record<string, string>;
	webhookSecret: string;
	fetchImpl?: typeof fetch;
}

const ADMIN_ROUTE = `/_emdash/api/plugins/${OTTA_PLUGIN_ID}/admin`;
const PUBLIC_ROUTE = (route: string): string => `/_emdash/api/plugins/${OTTA_PLUGIN_ID}/${route}`;

/** POST JSON to an em-dash route and unwrap `{ success, data }`. A refusal
 *  INSIDE `data` is the caller's to read. */
async function postEnvelope(
	deps: SeedOrdersDeps,
	path: string,
	body: unknown,
	headers: Record<string, string>,
	what: string,
): Promise<unknown> {
	const doFetch = deps.fetchImpl ?? fetch;
	const url = `${deps.siteUrl}${path}`;
	const res = await doFetch(url, {
		method: "POST",
		// em-dash's CSRF header: required for a cookie-authenticated write,
		// harmless on everything else.
		headers: { ...headers, "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${what}: POST ${url} → HTTP ${res.status}: ${await res.text()}`);
	const envelope = (await res.json()) as { success?: unknown; data?: unknown };
	if (envelope.success !== true) {
		throw new Error(`${what}: not a success envelope: ${JSON.stringify(envelope).slice(0, 300)}`);
	}
	return envelope.data;
}

const admin = (deps: SeedOrdersDeps, body: unknown, what: string): Promise<unknown> =>
	postEnvelope(deps, ADMIN_ROUTE, body, deps.authHeaders, what);

/** A public storefront route, called the way a shopper's browser would reach
 *  it: anonymous, no admin credential. */
const storefront = (deps: SeedOrdersDeps, route: string, body: unknown): Promise<unknown> =>
	postEnvelope(deps, PUBLIC_ROUTE(route), body, {}, route);

function ok<T>(data: unknown, what: string): T {
	if (data !== null && typeof data === "object" && (data as { ok?: unknown }).ok === true) {
		return data as T;
	}
	throw new Error(`${what} was refused: ${JSON.stringify(data).slice(0, 300)}`);
}

/** How many PAID orders the store has. */
export async function countPaidOrders(deps: SeedOrdersDeps): Promise<number> {
	const data = ok<{ orders: unknown[] }>(
		await admin(
			deps,
			{ type: CONSOLE_READ_INTERACTION, resource: "orders.list", filter: { status: "paid" } },
			"listing paid orders",
		),
		"listing paid orders",
	);
	return data.orders.length;
}

/** Refuse a store with a real Stripe key, then provision the e2e webhook secret. */
export async function provisionWebhookSecret(deps: SeedOrdersDeps): Promise<void> {
	const page = await admin(
		deps,
		{ type: "page_load", page: "/settings" },
		"reading the Settings page",
	);
	if (stripeSecretKeyIsSet(page)) {
		throw new Error(
			"this store has a Stripe secret key, so its orders take REAL payments. A signed test " +
				"webhook would mark an order paid for money that was never taken. Seed a stack " +
				"without one (remove the key in Settings, or start from a fresh .wrangler state).",
		);
	}
	const saved = await admin(
		deps,
		{
			type: "form_submit",
			action_id: "save-stripe-webhook-secret",
			values: { stripeWebhookSecret: deps.webhookSecret },
		},
		"saving the webhook secret",
	);
	// The settings handler answers with the re-rendered page and a toast; a
	// refused save says "not saved" there.
	const toast = (saved as { toast?: { type?: unknown; message?: unknown } } | null)?.toast;
	if (toast?.type !== "success") {
		throw new Error(`the webhook secret was not saved: ${JSON.stringify(toast ?? saved)}`);
	}
}

/**
 * Point the emailed sign-in link at THIS site's `/account/verify` (the
 * `settings:loginLinkUrl` field). Without it the plugin sends no link at all,
 * so the signed-in account specs could not sign anyone in. Only that field is
 * submitted: the settings handler leaves an absent field untouched, so the
 * from-address and the x402 settings keep whatever they had. `http:` is
 * accepted here only because the site is loopback (`isSavableLoginLinkUrl`).
 */
export async function provisionLoginLinkUrl(deps: SeedOrdersDeps): Promise<void> {
	const saved = await admin(
		deps,
		{
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { loginLinkUrl: `${deps.siteUrl}/account/verify` },
		},
		"saving the sign-in page address",
	);
	const toast = (saved as { toast?: { type?: unknown; message?: unknown } } | null)?.toast;
	if (toast?.type !== "success") {
		throw new Error(`the sign-in page address was not saved: ${JSON.stringify(toast ?? saved)}`);
	}
}

/** The first purchasable product, read through the products console. */
export async function findPurchasable(deps: SeedOrdersDeps): Promise<Purchasable> {
	const data = ok<{ products: CatalogRow[] }>(
		await admin(
			deps,
			{ type: CONSOLE_READ_INTERACTION, resource: `${PRODUCTS_CONSOLE_RESOURCE_PREFIX}list` },
			"listing products",
		),
		"listing products",
	);
	const picked = pickPurchasable(data.products);
	if (picked === null) {
		throw new Error(
			"no product is priced, active and in stock, so there is nothing to buy. Run " +
				"sites/staging/scripts/seed-demo-commerce.ts first.",
		);
	}
	return picked;
}

/** Place one order for `product` as a guest shopper and return its id. The
 *  buyer is the seed's shared address unless a spec names its own. */
export async function placeOrder(
	deps: SeedOrdersDeps,
	product: Purchasable,
	buyer: string = E2E_BUYER,
): Promise<string> {
	const cart = ok<{ cartId: string }>(
		await storefront(deps, STOREFRONT_CART_CREATE_ROUTE, { currency: product.currency }),
		"creating a cart",
	);
	ok(
		await storefront(deps, STOREFRONT_CART_LINE_ADD_ROUTE, {
			cartId: cart.cartId,
			sku: product.sku,
			productId: product.productId,
			qty: 1,
			idempotencyKey: randomUUID(),
		}),
		`adding ${product.sku} to the cart`,
	);
	const placed = ok<{ orderId: string }>(
		await storefront(deps, STOREFRONT_CHECKOUT_PLACE_ROUTE, {
			cartId: cart.cartId,
			buyerRef: buyer,
			idempotencyKey: checkoutIdempotencyKey(cart.cartId),
			shippingAddress: {
				name: "E2E Shopper",
				line1: "1 Test Street",
				city: "Springfield",
				region: "CA",
				postalCode: "12345",
				country: "US",
			},
		}),
		// The usual refusal here is PAYMENT_GATEWAY_UNAVAILABLE-shaped: the dev
		// server was not started with OTTA_E2E_STRIPE_OFFLINE=1.
		"placing the order (is the dev server running with OTTA_E2E_STRIPE_OFFLINE=1?)",
	);
	return placed.orderId;
}

interface OrderDetail {
	state: string;
	totals: { totalCents: number; currency: string };
}

async function readOrder(deps: SeedOrdersDeps, orderId: string): Promise<OrderDetail> {
	const data = ok<{ order: OrderDetail }>(
		await admin(
			deps,
			{ type: CONSOLE_READ_INTERACTION, resource: "orders.detail", orderId },
			`reading order ${orderId}`,
		),
		`reading order ${orderId}`,
	);
	return data.order;
}

/** Pay one placed order the way Stripe would: a signed success, through the
 *  site's own webhook endpoint. Returns the order's state afterwards. */
export async function settleOrder(deps: SeedOrdersDeps, orderId: string): Promise<string> {
	const order = await readOrder(deps, orderId);
	const { body, signatureHeader } = await signStripeWebhook(
		{
			// Unique per order: settlement dedupes on the event id, so a re-sent
			// event is a no-op rather than a second capture.
			eventId: `evt_e2e_${orderId}`,
			type: "payment_intent.succeeded",
			// The handle the offline gateway minted for this order.
			paymentIntentId: `pi_${orderId}`,
			orderId,
			amountCents: order.totals.totalCents,
			currency: order.totals.currency.toLowerCase(),
		},
		deps.webhookSecret,
	);
	const doFetch = deps.fetchImpl ?? fetch;
	const res = await doFetch(`${deps.siteUrl}/webhooks/stripe`, {
		method: "POST",
		headers: { "content-type": "application/json", "stripe-signature": signatureHeader },
		// The BYTES, unchanged: the HMAC is over them, so a re-serialized body
		// would not verify. The cast is the DOM `BodyInit` lib not accepting a
		// generically-typed `Uint8Array`, not a conversion.
		body: body as BodyInit,
	});
	if (!res.ok) {
		throw new Error(`the webhook for ${orderId} answered HTTP ${res.status}: ${await res.text()}`);
	}
	return (await readOrder(deps, orderId)).state;
}

/** Bring the store up to `target` paid orders. Returns how many it placed. */
export async function seedPaidOrders(deps: SeedOrdersDeps, target: number): Promise<number> {
	const existing = await countPaidOrders(deps);
	if (existing >= target) return 0;
	await provisionWebhookSecret(deps);
	const product = await findPurchasable(deps);
	let placed = 0;
	for (let n = existing; n < target; n++) {
		const orderId = await placeOrder(deps, product);
		const state = await settleOrder(deps, orderId);
		if (state !== "paid") {
			throw new Error(`order ${orderId} is "${state}" after its signed success, not "paid".`);
		}
		console.info(`[otta] order ${orderId} placed and paid (${product.sku})`);
		placed++;
	}
	return placed;
}

async function main(): Promise<void> {
	const siteUrl = assertLoopbackSite(process.env["SITE_URL"] ?? "http://127.0.0.1:4500");
	const target = Number(process.env["OTTA_E2E_PAID_ORDERS"] ?? String(DEFAULT_PAID_ORDERS));
	if (!Number.isInteger(target) || target < 1) {
		throw new Error(`OTTA_E2E_PAID_ORDERS must be a positive integer, got ${String(target)}`);
	}
	const authHeaders = await cmsAuthHeaders(siteUrl);
	const placed = await seedPaidOrders(
		{
			siteUrl,
			authHeaders,
			webhookSecret: process.env["STRIPE_WEBHOOK_SECRET"] ?? E2E_WEBHOOK_SECRET,
		},
		target,
	);
	console.info(
		placed === 0
			? `[otta] done — the store already has ${String(target)} or more paid orders; nothing placed.`
			: `[otta] done — ${String(placed)} paid order(s) placed against ${siteUrl}.`,
	);
}

// Only when run directly, so the helpers stay importable (same rule, and same
// `pathToFileURL` reason, as seed-demo-commerce.ts).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		console.error("[otta] seed-e2e-orders failed:", err);
		process.exitCode = 1;
	});
}
