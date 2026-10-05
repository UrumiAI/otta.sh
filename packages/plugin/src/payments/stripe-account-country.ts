/**
 * The Stripe ACCOUNT's country, and what checkout makes of it (issue #382).
 *
 * WHY CHECKOUT CARES. A Stripe account in India takes payments from abroad as
 * EXPORTS, and Stripe refuses an export payment that does not carry the buyer's
 * name and address — for services and digital goods as much as for physical
 * ones (<https://docs.stripe.com/india-exports>). ADR-0021 only requires an
 * address for a physical cart in a store with zones, so a digital or no-zone
 * cart on such an account reached the pay step and was refused there. A store
 * whose account is in India must therefore collect the address for EVERY cart.
 * Nothing in the store's own configuration says where its Stripe account is;
 * Stripe does: `GET /v1/account` → `country`.
 *
 * CACHED, NEVER ASKED PER CHECKOUT. The answer lives in plugin kv
 * ({@link STRIPE_ACCOUNT_COUNTRY_KEY}) beside a digest of the key it was asked
 * with, so a checkout reads kv and reaches Stripe only when nothing usable is
 * cached:
 *  - a KNOWN country is kept for as long as the key is unchanged — an account
 *    cannot change country, and a new key (possibly another account) does not
 *    match the digest, so it is asked afresh;
 *  - the Settings save of the secret key asks at once ({@link
 *    refreshStripeAccountCountry}), so a newly provisioned store normally never
 *    asks from a checkout at all;
 *  - an UNKNOWN answer is retried, lazily, after a back-off sized to how likely
 *    a retry is to help ({@link RETRY_AFTER_MS}).
 *
 * UNKNOWN MEANS "NOT REQUIRED", deliberately, and is logged. The country can be
 * unknown because no key is set (no card checkout at all), because Stripe could
 * not be reached, because the key was refused, or because a RESTRICTED key
 * (`rk_…`) has no permission to read account details (a 403). Requiring the
 * address whenever the country is unknown would add a mandatory address form to
 * every digital checkout of every store whose key is restricted or whose Stripe
 * call blipped — nearly all of them outside India — to protect the few inside
 * it, for whom "unknown" costs exactly what it cost before this change: Stripe
 * refuses the address-less payment. So unknown fails OPEN for the buyer, and
 * LOUD for the merchant: a warning in the log, and the Payments group of admin
 * Settings states the country it found or why it found none — with what to do
 * about a restricted key.
 *
 * Sandbox-clean: the one egress is `ctx.http` to `api.stripe.com` (a constant
 * `allowedHosts` entry), through the Stripe adapter's own reader.
 */

import { fetchStripeAccountCountry } from "@otta-sh/payments-stripe";
import { stripeSecretKeyFromKv } from "../payment-secrets.js";
import type { PluginContext } from "../types.js";

/** Where the last answer is kept. Not a `settings:*` key: nobody sets it. */
export const STRIPE_ACCOUNT_COUNTRY_KEY = "state:stripeAccountCountry";

/** Account countries whose Stripe account refuses a payment without the
 *  buyer's name and address. */
const ADDRESS_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set(["IN"]);

type UnknownReason = "permission_denied" | "authentication_failed" | "unavailable";

/**
 * How long an UNKNOWN answer stands before a checkout asks again. A restricted
 * key's 403 will not fix itself soon (the merchant must change the key's
 * permissions, and saving the key again re-checks at once), a refused key
 * likewise; an unreachable Stripe usually will.
 */
const RETRY_AFTER_MS: Record<UnknownReason, number> = {
	permission_denied: 24 * 60 * 60 * 1000,
	authentication_failed: 60 * 60 * 1000,
	unavailable: 5 * 60 * 1000,
};

/** The bound on the account read when it runs inside a checkout render. */
const CHECKOUT_READ_TIMEOUT_MS = 2_500;

export type StripeAccountCountryStatus =
	/** No Stripe secret key is stored. */
	| { status: "not_configured" }
	/** A key is stored, but nothing has been learned with it yet (peek only). */
	| { status: "not_checked" }
	| { status: "known"; country: string; checkedAt: string }
	| { status: UnknownReason; checkedAt: string };

/** The kv record: the answer, and a digest of the key it was asked with. */
interface StoredRecord {
	keyDigest: string;
	status: "known" | UnknownReason;
	country?: string;
	checkedAt: string;
}

function isStoredRecord(value: unknown): value is StoredRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	if (typeof r["keyDigest"] !== "string" || typeof r["checkedAt"] !== "string") return false;
	if (r["status"] === "known") {
		return typeof r["country"] === "string" && /^[A-Z]{2}$/.test(r["country"]);
	}
	return (
		r["status"] === "permission_denied" ||
		r["status"] === "authentication_failed" ||
		r["status"] === "unavailable"
	);
}

/**
 * SHA-256 of the key, hex. It ties a cached answer to the key that produced it
 * without keeping any part of the key in the record (the key itself sits in kv
 * already; the digest adds nothing an attacker could use).
 */
async function digestOf(secretKey: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secretKey)),
	);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function statusOf(record: StoredRecord): StripeAccountCountryStatus {
	return record.status === "known"
		? { status: "known", country: record.country ?? "", checkedAt: record.checkedAt }
		: { status: record.status, checkedAt: record.checkedAt };
}

/** Is a cached record still the answer, at `now`? */
function isFresh(record: StoredRecord, now: number): boolean {
	if (record.status === "known") return true;
	const checkedAt = Date.parse(record.checkedAt);
	return Number.isFinite(checkedAt) && now - checkedAt < RETRY_AFTER_MS[record.status];
}

async function readRecord(ctx: PluginContext): Promise<StoredRecord | null> {
	try {
		const value = await ctx.kv.get<unknown>(STRIPE_ACCOUNT_COUNTRY_KEY);
		return isStoredRecord(value) ? value : null;
	} catch {
		return null;
	}
}

/** Ask Stripe, record the answer (best-effort), return it. */
async function askStripe(
	ctx: PluginContext,
	secretKey: string,
	keyDigest: string,
	now: number,
	timeoutMs: number,
): Promise<StripeAccountCountryStatus> {
	const result = await fetchStripeAccountCountry({
		secretKey,
		fetch: (input, init) => ctx.http.fetch(String(input), init),
		timeoutMs,
	});
	const checkedAt = new Date(now).toISOString();
	const record: StoredRecord = result.ok
		? { keyDigest, status: "known", country: result.country, checkedAt }
		: { keyDigest, status: result.reason, checkedAt };
	try {
		await ctx.kv.set(STRIPE_ACCOUNT_COUNTRY_KEY, record);
	} catch {
		// A kv that cannot write costs a re-ask next time, never the answer now.
	}
	return statusOf(record);
}

interface ReadOptions {
	/** Epoch ms — tests move time; production passes nothing. */
	now?: number;
	timeoutMs?: number;
}

/**
 * The account's country, from the cache when it holds a fresh answer for the
 * stored key, else from Stripe (then cached). Never throws.
 */
export async function readStripeAccountCountry(
	ctx: PluginContext,
	options: ReadOptions = {},
): Promise<StripeAccountCountryStatus> {
	const secretKey = await stripeSecretKeyFromKv(ctx);
	if (secretKey === undefined) return { status: "not_configured" };
	const now = options.now ?? Date.now();
	const keyDigest = await digestOf(secretKey);
	const cached = await readRecord(ctx);
	if (cached !== null && cached.keyDigest === keyDigest && isFresh(cached, now)) {
		return statusOf(cached);
	}
	return askStripe(ctx, secretKey, keyDigest, now, options.timeoutMs ?? CHECKOUT_READ_TIMEOUT_MS);
}

/**
 * Ask Stripe now, whatever is cached — the Settings save of the secret key, so
 * the answer is in place before the first checkout needs it. Never throws.
 */
export async function refreshStripeAccountCountry(
	ctx: PluginContext,
	options: ReadOptions = {},
): Promise<StripeAccountCountryStatus> {
	const secretKey = await stripeSecretKeyFromKv(ctx);
	if (secretKey === undefined) return { status: "not_configured" };
	const now = options.now ?? Date.now();
	return askStripe(
		ctx,
		secretKey,
		await digestOf(secretKey),
		now,
		options.timeoutMs ?? CHECKOUT_READ_TIMEOUT_MS,
	);
}

/**
 * What the cache holds for the stored key, WITHOUT asking Stripe — for the
 * Settings screen, whose page load must not wait on a provider. Stale unknown
 * answers are reported as they stand. Never throws.
 */
export async function peekStripeAccountCountry(
	ctx: PluginContext,
): Promise<StripeAccountCountryStatus> {
	const secretKey = await stripeSecretKeyFromKv(ctx);
	if (secretKey === undefined) return { status: "not_configured" };
	const cached = await readRecord(ctx);
	if (cached === null || cached.keyDigest !== (await digestOf(secretKey))) {
		return { status: "not_checked" };
	}
	return statusOf(cached);
}

/** Once per isolate per reason: a fact about the deployment, not the request. */
const warned = new Set<string>();

const UNKNOWN_WARNING: Record<UnknownReason, string> = {
	permission_denied:
		"the restricted key cannot read account details (Stripe answered 403). If the Stripe account is in India, give the key read access to Account, or use the secret key",
	authentication_failed: "Stripe refused the secret key (401)",
	unavailable: "Stripe could not be reached; it is asked again in a few minutes",
};

/**
 * THE question checkout asks: must every buyer give their name and address?
 * Only when the account is KNOWN to be in India — see the module doc for why an
 * unknown country is not required. Never throws: a failure is unknown.
 */
export async function checkoutRequiresBuyerAddress(ctx: PluginContext): Promise<boolean> {
	let found: StripeAccountCountryStatus;
	try {
		found = await readStripeAccountCountry(ctx);
	} catch {
		found = { status: "unavailable", checkedAt: new Date().toISOString() };
	}
	if (found.status === "known") return ADDRESS_REQUIRED_COUNTRIES.has(found.country);
	if (found.status !== "not_configured" && found.status !== "not_checked") {
		if (!warned.has(found.status)) {
			warned.add(found.status);
			console.warn(
				`[otta] the Stripe account's country is unknown — ${UNKNOWN_WARNING[found.status]}. Checkout does not require the buyer's address until it is known (issue #382).`,
			);
		}
	}
	return false;
}

/** Does an account in this country need the buyer's address on every payment? */
export function countryRequiresBuyerAddress(country: string): boolean {
	return ADDRESS_REQUIRED_COUNTRIES.has(country);
}
