import type { PluginContext } from "emdash/plugin";
import { MAX_QTY } from "./model.js";
import { isCurrency, paymentIncrement, randomHex } from "./util.js";

/** The merchant's settings, from the manifest's `settingsSchema` (EmDash renders the form). */
export interface Settings {
	stripeSecretKey: string | null;
	stripeWebhookSecret: string | null;
	currency: string;
	successUrl: string;
	cancelUrl: string;
	/** ISO-2 codes Stripe collects a shipping address for; empty = no address. */
	shippingCountries: string[];
	/** Flat shipping in minor units, 0 = free. */
	flatShipping: number;
	/** False when the currency setting is filled in but not one Core sells in. */
	currencyValid: boolean;
	/** The EmDash collection products live in. */
	productsCollection: string;
	/** Let buyers enter Stripe promotion codes at Checkout (off by default). */
	allowPromotionCodes: boolean;
	/** Most units of one product per order (1..MAX_QTY). */
	maxQtyPerLine: number;
	/** New checkouts are refused while this many orders are pending payment. */
	maxOpenCheckouts: number;
	/** The same, per buyer (client IP, hashed). */
	maxOpenPerBuyer: number;
	/** New checkouts are refused once this many were created in the last 10 minutes. */
	maxNewCheckouts: number;
	/** The shop's address, recorded by the first authenticated Setup page load. */
	shopOrigin: string | null;
	/** Random per-install salt for buyer tags (written once by the install hook). */
	ipSalt: string | null;
	/** Sweep part E's paging position when a pass did not finish (see sweep.ts). */
	scanAfter: string | null;
	/**
	 * A setting that is filled in but invalid. Checkout refuses as NOT_CONFIGURED
	 * rather than guess (a typo'd currency must not charge euro prices in dollars).
	 * Settling existing orders never depends on it.
	 */
	problem: string | null;
}

export const SETTING_DEFAULTS = {
	currency: "USD",
	// The key in the fragment: never sent to the shop's server logs or in a Referer.
	successUrl: "/checkout/success?order={ORDER_ID}#key={ORDER_KEY}",
	cancelUrl: "/cart",
	productsCollection: "products",
} as const;

/** Not in the settings form: created once per install, read with the other settings for free. */
export const IP_SALT_SETTING = "_ipSalt";
/** Not in the form: the shop address an admin's own request came to (see checkout absolute()). */
export const SHOP_ORIGIN_SETTING = "_shopOrigin";
/** Not in the form either: kept under settings: so the one settings read returns it for free. */
export const SCAN_AFTER_SETTING = "_scanAfter";

/** Create the buyer-tag salt if this install has none (install/activate hooks; 1-2 calls). */
export async function ensureIpSalt(ctx: PluginContext): Promise<string | null> {
	const k = `settings:${IP_SALT_SETTING}`;
	const kv = ctx.kv as unknown as {
		get(k: string): Promise<unknown>;
		compareAndSet?(k: string, expected: string | null, v: unknown): Promise<{ applied: boolean }>;
		set(k: string, v: unknown): Promise<void>;
	};
	const have = await kv.get(k);
	if (typeof have === "string") return have;
	// Create-if-absent, so install and activate racing cannot replace a salt in use.
	const fresh = randomHex(32);
	if (kv.compareAndSet) {
		if ((await kv.compareAndSet(k, null, fresh)).applied) return fresh;
		const now = await kv.get(k);
		return typeof now === "string" ? now : null;
	}
	await kv.set(k, fresh);
	return fresh;
}

/** One bridge call: `kv.list("settings:")` returns every setting at once. */
export async function loadSettings(ctx: PluginContext): Promise<Settings> {
	const raw: Record<string, unknown> = {};
	for (const e of await ctx.kv.list("settings:")) raw[e.key.slice(9)] = e.value;
	const str = (k: string) =>
		typeof raw[k] === "string" && (raw[k] as string).trim() !== ""
			? (raw[k] as string).trim()
			: null;
	const problems: string[] = [];
	const currency = str("currency")?.toUpperCase() ?? SETTING_DEFAULTS.currency;
	if (!isCurrency(currency))
		problems.push(
			`"${currency}" is not a currency Otta Core can sell in. Enter a supported 3-letter code such as USD, EUR or GBP.`,
		);
	/** Empty = default; filled in = must be a whole number in range. */
	const int = (k: string, def: number, min: number, max: number, what: string) => {
		const v = raw[k];
		if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return def;
		const n = typeof v === "number" ? v : Number(String(v).trim());
		if (Number.isInteger(n) && n >= min && n <= max) return n;
		problems.push(`${what} must be a whole number from ${min} to ${max}.`);
		return def;
	};
	const ship = int("flatShipping", 0, 0, 10_000_000, "flat shipping (minor units)");
	const inc = isCurrency(currency) ? paymentIncrement(currency) : 1;
	if (ship % inc !== 0)
		problems.push(
			`Flat shipping must be a multiple of ${inc} in ${currency} (smallest unit). Round it and save.`,
		);
	// The order key is the buyer's secret for reading the order: it belongs only in
	// the success URL. Stripe's cancel redirect is not the place for it.
	// The order id lets a browser release its own unpaid checkout: it must not reach
	// the shop's logs or analytics through Stripe's cancel redirect.
	const success = str("successUrl") ?? SETTING_DEFAULTS.successUrl;
	if (!success.includes("{ORDER_ID}") || !success.includes("{ORDER_KEY}"))
		problems.push(
			"The success URL must contain {ORDER_ID} and {ORDER_KEY}: the success page needs both to show the order.",
		);
	if ((str("cancelUrl") ?? "").includes("{ORDER_ID}"))
		problems.push(
			"The cancel URL must not contain {ORDER_ID}: while an order is unpaid its id lets the buyer release it, so it stays in the buyer's browser.",
		);
	if ((str("cancelUrl") ?? "").includes("{ORDER_KEY}"))
		problems.push(
			"The cancel URL must not contain {ORDER_KEY}: that key is the buyer's secret and belongs only in the success URL.",
		);
	const countries = (str("shippingCountries") ?? "")
		.split(",")
		.map((c) => c.trim().toUpperCase())
		.filter((c) => c !== "");
	const badCountry = countries.find((c) => !/^[A-Z]{2}$/.test(c));
	if (badCountry !== undefined)
		problems.push(
			`"${badCountry}" is not a country code. Use 2-letter codes separated by commas, for example US, GB, DE.`,
		);
	return {
		stripeSecretKey: str("stripeSecretKey"),
		stripeWebhookSecret: str("stripeWebhookSecret"),
		currency: isCurrency(currency) ? currency : SETTING_DEFAULTS.currency,
		currencyValid: isCurrency(currency),
		successUrl: str("successUrl") ?? SETTING_DEFAULTS.successUrl,
		cancelUrl: str("cancelUrl") ?? SETTING_DEFAULTS.cancelUrl,
		shippingCountries: countries.filter((c) => /^[A-Z]{2}$/.test(c)),
		flatShipping: ship,
		productsCollection: str("productsCollection") ?? SETTING_DEFAULTS.productsCollection,
		allowPromotionCodes:
			raw["allowPromotionCodes"] === true || raw["allowPromotionCodes"] === "true",
		maxQtyPerLine: int("maxQtyPerLine", MAX_QTY, 1, MAX_QTY, "max quantity per product"),
		maxOpenCheckouts: int("maxOpenCheckouts", 100, 1, 10_000, "max open checkouts"),
		ipSalt: str(IP_SALT_SETTING),
		shopOrigin: str(SHOP_ORIGIN_SETTING),
		scanAfter: str(SCAN_AFTER_SETTING),
		maxNewCheckouts: int("maxNewCheckouts", 300, 1, 100_000, "new checkouts per 10 minutes"),
		maxOpenPerBuyer: int("maxOpenPerBuyer", 5, 1, 1000, "max open checkouts per buyer"),
		problem: problems.length ? problems.join("; ") : null,
	};
}
