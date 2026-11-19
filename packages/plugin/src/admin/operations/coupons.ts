/**
 * The admin COUPON operations: the decision half of every coupon write, with no
 * form parsing and no notice.
 *
 * WHY THEY ARE HERE. These rules used to live inline in the Coupons console
 * (`coupons-page.ts`), one layer above `AdminRulesSurface`: which half of a
 * create collided (the code lookup after a 409), which rules-client refusals are
 * the coupon's CURRENCY (typed `CommerceInputError`s on field `currency`), and
 * how an edit's 409 means "the currency moved since it was read". A second caller
 * (the MCP tools) calling the surface directly would have to restate all of them.
 * So each write is one function here, and both callers go through it: the page
 * parses its form, calls the operation, and turns the outcome into a notice; an
 * MCP route validates its input, calls the operation, and turns the outcome into
 * JSON. Moved verbatim — no rule changed on the way.
 *
 * WHAT STAYS ON THE PAGE. Form parsing (`parseEconomics`, `parseSharedFields`,
 * the carried current values, `boundsCurrency`) and every word of notice copy
 * (`couponCurrencyRefusalCopy`, `createCouponNotice`, …). An outcome carries the
 * typed REASON, never the page's copy.
 *
 * ONE NEW PIECE: {@link patchCoupon}. The surface's `updateCoupon` is a FULL
 * REPLACE (an omitted field is cleared), which is what the page wants — its one
 * form carries every field. An agent sending only `maxUses` must not clear the
 * window and the minimum spend, so `patchCoupon` reads the coupon, merges the
 * patch over it, and writes the whole coupon through {@link updateCoupon}. Only
 * MCP calls it; the page's save is unchanged.
 */
import { isCommerceInputError } from "../../commerce/commerce-input.js";
import type {
	AdminRulesSurface,
	CouponEdit,
	CouponInput,
	CouponRetireResult,
	CouponSummaryWire,
	CouponWire,
	RulesDeleteResult,
} from "../admin-rules-surface.js";

/** The `currency_refused` reason for an edit the rules client refused because
 *  the coupon's currency is no longer the one the edit was read against (its
 *  409). The other reasons are the rules client's own `CommerceInputError`
 *  reasons on field `currency` (`COUPON_CURRENCY_REFUSAL`,
 *  `UNSUPPORTED_CURRENCY_REASON`, `CURRENCY_SHAPE_REASON`). */
export const COUPON_CURRENCY_MOVED = "currency_moved";

/** Which half of a create collided: the CODE (another coupon has it, whatever
 *  its case), the ID (no coupon has the code, so the ID was taken), both — this
 *  coupon already exists, typically a retried create — or `unknown` when the
 *  code lookup could not answer. */
export type CouponCollision = "code" | "id" | "same" | "unknown";

export type CouponWriteOutcome<T> =
	/** Written; `coupon` is the row as stored. */
	| { kind: "ok"; coupon: T }
	/** A create collided (409) and nothing was written; `taken` says which half. */
	| { kind: "code_taken"; code: string; taken: CouponCollision }
	/** The coupon's currency was refused and nothing was written. `reason` is the
	 *  rules client's typed reason, or {@link COUPON_CURRENCY_MOVED}. */
	| { kind: "currency_refused"; reason: string; message: string }
	/** The rules client refused another field before any write. */
	| { kind: "invalid"; field: string; reason: string; message: string }
	/** No coupon has that id. */
	| { kind: "not_found" }
	/** Refused for any other reason (e.g. 400: the edit blanked the coupon's own
	 *  amount or rate); nothing was written. */
	| { kind: "failed"; status: number };

/** A rules-client `CommerceInputError` as an outcome; anything else is rethrown
 *  (an unknown error is not a refusal, and the caller must not say it was). */
function refusal(err: unknown): CouponWriteOutcome<never> {
	if (!isCommerceInputError(err)) throw err;
	return err.field === "currency"
		? { kind: "currency_refused", reason: err.reason, message: err.message }
		: { kind: "invalid", field: err.field, reason: err.reason, message: err.message };
}

async function couponCollision(
	client: AdminRulesSurface,
	id: string,
	code: string,
): Promise<CouponCollision> {
	const byCode = await client.getCoupon(code).catch(() => undefined);
	if (byCode === undefined) return "unknown";
	if (byCode === null) return "id";
	return byCode.id === id ? "same" : "code";
}

/** Why a create without its own economics is refused (`invalid`'s `reason`). */
const COUPON_ECONOMICS_REQUIRED = {
	amountCents: "a fixed_amount coupon needs its amount",
	currency: "a fixed_amount coupon needs the currency its amount is in",
	rateBps: "a percentage coupon needs its rate",
} as const;

/**
 * The field a coupon of this type cannot be created without, when it is
 * missing, else `undefined`. A fixed_amount coupon is an amount IN a currency;
 * a percentage coupon is its rate. Without them the row would be created and
 * then refused at every checkout (`validate-coupon`). The rules client's create
 * checks shapes only; its update already refuses blanking these (the route's
 * 400), so this closes the create path for every caller (the page and MCP).
 */
function missingEconomics(input: CouponInput): keyof typeof COUPON_ECONOMICS_REQUIRED | undefined {
	if (input.type === "fixed_amount") {
		if (input.amountCents === undefined || input.amountCents === null) return "amountCents";
		if (input.currency === undefined || input.currency === null) return "currency";
	} else if (input.type === "percentage") {
		if (input.rateBps === undefined || input.rateBps === null) return "rateBps";
	}
	return undefined;
}

/**
 * Create a coupon. A collision (409) is classified by looking the CODE up — the
 * store does not say which of the two was taken. A rules-client refusal of the
 * input is an outcome, not a throw, and so is a coupon without its own
 * economics ({@link COUPON_ECONOMICS_REQUIRED}), refused before any write.
 */
export async function createCoupon(
	client: AdminRulesSurface,
	input: CouponInput,
): Promise<CouponWriteOutcome<CouponWire>> {
	const missing = missingEconomics(input);
	if (missing !== undefined) {
		const reason = COUPON_ECONOMICS_REQUIRED[missing];
		return { kind: "invalid", field: missing, reason, message: `invalid ${missing}: ${reason}` };
	}
	let result: Awaited<ReturnType<AdminRulesSurface["createCoupon"]>>;
	try {
		result = await client.createCoupon(input);
	} catch (e) {
		return refusal(e);
	}
	if (result.ok) return { kind: "ok", coupon: result.value };
	if (result.status !== 409) return { kind: "failed", status: result.status };
	return {
		kind: "code_taken",
		code: input.code,
		taken: await couponCollision(client, input.id, input.code),
	};
}

/**
 * Replace a coupon's editable fields WHOLE, as the page's save does: a field the
 * edit does not carry is cleared (the surface's last-writer-wins full replace).
 * `edit.currency`, when sent, is the currency the amounts were read in; a coupon
 * whose currency has moved since is `currency_refused` with
 * {@link COUPON_CURRENCY_MOVED}. For a partial edit, see {@link patchCoupon}.
 */
export async function updateCoupon(
	client: AdminRulesSurface,
	couponId: string,
	edit: CouponEdit,
): Promise<CouponWriteOutcome<CouponWire>> {
	let result: Awaited<ReturnType<AdminRulesSurface["updateCoupon"]>>;
	try {
		result = await client.updateCoupon(couponId, edit);
	} catch (e) {
		return refusal(e);
	}
	if (result.ok) return { kind: "ok", coupon: result.value };
	if (result.reason === "not_found") return { kind: "not_found" };
	if (result.status === 409) {
		return {
			kind: "currency_refused",
			reason: COUPON_CURRENCY_MOVED,
			message: "the coupon's currency changed since it was read; nothing was saved",
		};
	}
	return { kind: "failed", status: result.status };
}

/** The largest page the rules surface serves. */
const SCAN_PAGE = 100;

/**
 * One coupon's full summary (the window included), by ID. The surface reads one
 * coupon only by CODE (`getCoupon`), and that projection omits the window, so
 * this walks the list — the one read that carries both. Linear in the number of
 * coupons; fine for an agent's single edit, and the reason this is not used on
 * any page.
 */
async function findCouponById(
	client: AdminRulesSurface,
	couponId: string,
): Promise<CouponSummaryWire | null> {
	let cursor: string | undefined;
	for (;;) {
		const page = await client.listCoupons(
			{},
			cursor === undefined ? { limit: SCAN_PAGE } : { cursor, limit: SCAN_PAGE },
		);
		const hit = page.coupons.find((c) => c.id === couponId);
		if (hit !== undefined) return hit;
		if (page.nextCursor === null) return null;
		cursor = page.nextCursor;
	}
}

/**
 * A PARTIAL edit — MCP only. Reads the coupon, keeps every field the patch does
 * not mention (an `undefined` key is "not mentioned"; an explicit `null` clears
 * that field), and writes the whole coupon through {@link updateCoupon}.
 *
 * The stored currency rides along unless the patch names one, so the write is
 * conditioned on it still being the one read: a currency bound in between is
 * `currency_refused` ({@link COUPON_CURRENCY_MOVED}), never a cap re-read in a
 * different unit. Any OTHER edit landing between the read and the write is lost
 * — the surface is last-writer-wins, as the page's save and retire are.
 */
export async function patchCoupon(
	client: AdminRulesSurface,
	couponId: string,
	patch: Partial<CouponEdit>,
): Promise<CouponWriteOutcome<CouponWire>> {
	const current = await findCouponById(client, couponId);
	if (current === null) return { kind: "not_found" };
	const keep = <K extends keyof CouponEdit>(field: K): CouponEdit[K] =>
		patch[field] === undefined ? current[field] : patch[field];
	// EVERY editable key, explicitly — the surface's edit is a full replace.
	const merged: CouponEdit = {
		currency: keep("currency"),
		amountCents: keep("amountCents"),
		rateBps: keep("rateBps"),
		capCents: keep("capCents"),
		minSubtotalCents: keep("minSubtotalCents"),
		startsAt: keep("startsAt"),
		expiresAt: keep("expiresAt"),
		maxUses: keep("maxUses"),
		maxUsesPerCustomer: keep("maxUsesPerCustomer"),
	};
	return updateCoupon(client, couponId, merged);
}

/** End a coupon now, on the surface's own clock. The surface owns the
 *  read-then-write and the window rules; this is the shared entry point. */
export function retireCoupon(
	client: AdminRulesSurface,
	couponId: string,
): Promise<CouponRetireResult> {
	return client.retireCoupon(couponId);
}

/** Delete a coupon. A redeemed one is withheld (`in_use`) to keep the
 *  redemption audit trail; a missing one is the idempotent `not_found`. */
export function deleteCoupon(
	client: AdminRulesSurface,
	couponId: string,
): Promise<RulesDeleteResult> {
	return client.deleteCoupon(couponId);
}
