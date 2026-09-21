/**
 * `InProcessAdminRulesClient` — the admin RULES console surface (shipping zones
 * → methods → rates, tax classes → rates, coupons) with commerce truth held on
 * the plugin's own document store (work order 02, INC-B10c-i).
 *
 * WHAT THIS CLASS IS. The sole implementation of `AdminRulesSurface`: the same
 * twenty-five methods, the same argument shapes, the same RETURN VALUES — every
 * field the `*Wire` types carry — with the `@otta-sh/domain` ports composed over
 * the `@otta-sh/store-emdash` adapters bound to `ctx.storage` instead of a
 * commerce service. Nothing here reaches for egress; `ctx.http` is never
 * touched.
 *
 * NO FIELD IS NARROWED, and two shapes in particular are NOT unified because
 * the wire deliberately keeps them apart:
 *  - `CouponWire` (the detail read) omits `startsAt`/`expiresAt`, exactly as the
 *    service's `serializeCoupon` does, while `CouponSummaryWire` (the list row)
 *    carries them PLUS `createdAt`, because the console renders the validity
 *    window straight off the list and must not N+1 into a detail read per row;
 *  - `CouponsListResult.total` is present on every page this tier serves and an
 *    ABSENT total is never spelled `0` — the field is optional only so a service
 *    older than it can omit it.
 *
 * LWW VERSUS CAS IS PER-ENTITY, and homogenizing it would be a silent data-loss
 * bug rather than a tidy-up. Zones, shipping methods, tax classes and coupons are
 * LAST-WRITER-WINS (`RulesUpdateResult`, no `stale` arm) because they carry no
 * money. Shipping RATES and tax RATES are compare-and-set (`RulesCasUpdateResult`,
 * which has one) and THE CAS TOKEN IS THE MONEY/RATE FIELD ITSELF —
 * `expectedAmountCents`, `expectedRateBps` — not a version counter. A losing edit
 * comes back `stale` carrying `current`, the fresh row, so the console reloads
 * rather than blind-retrying; `current` may legitimately be `null` on the wire
 * type and is passed through as the store spells it.
 *
 * FULL-REPLACE EDITS HAVE REQUIRED-NULLABLE KEYS, and this tier enforces them
 * even though no zod schema stands in front of it. `ShippingZoneEdit.regions`,
 * `ShippingRateEdit.minSubtotalCents` and `TaxRateEdit.appliesToShipping` are
 * REQUIRED on the wire precisely so an omitted key is a 400 rather than a silent
 * wipe of the zone's match list / the free-shipping threshold / the shipping-tax
 * behaviour. `undefined` therefore never means "leave unchanged" here: a missing
 * key is refused, and only an explicit `null` clears.
 *
 * COUPON IDENTITY IS IMMUTABLE and its economics cannot be blanked. `CouponEdit`
 * omits id/code/type/currency. The "a `fixed_amount` coupon cannot lose its
 * `amountCents`, a `percentage` coupon cannot lose its `rateBps`" rule lived ONLY
 * in the service route (issue #75 — before that it lived only in the plugin's own
 * form parser, so a direct API caller could blank a live coupon), so
 * `updateCoupon` mirrors the route's FETCH-THEN-VALIDATE: read the coupon to
 * learn its immutable `type`, then refuse before any write. A coupon deleted
 * between the read and the update still surfaces as the pre-existing `not_found`,
 * so the extra read adds no new race.
 *
 * NO ADMIN AUTH HERE, deliberately (ADR-0014 D3). EmDash's own admin auth and
 * CSRF gate the console routes that construct this; there is no service to
 * authenticate to, so there is nothing to authenticate WITH. The HTTP tier's
 * `X-Internal-Token` / `X-Service-Token` are transport concerns and stay on the
 * transport, and its auth-rejection cases stay in its own file.
 *
 * HOW A REFUSED INPUT SURFACES, and the ONE arm this tier deliberately leaves
 * unreachable. The request schemas that used to stand in front of every call are
 * mirrored below through `commerce-input.ts`, and a refused input REJECTS — it
 * never resolves to a synthesized status. That is a departure from the orders
 * client, and it is forced by the shape of `RulesCreateResult`: its only failure
 * arm is `{ ok: false, status }`, with no typed reason at all, so "fill it in
 * in-process" would mean inventing a wire status for a wire that does not exist.
 * The arm is therefore HTTP-ONLY and genuinely untested on this tier, said out
 * loud rather than faked. For symmetry the update/delete results' `reason:
 * "error"` arms are left to the transport too, with ONE exception that is a
 * ported ROUTE behaviour rather than a boundary shape check: the coupon-economics
 * refusal above answers `{ ok: false, reason: "error" }` on both tiers, so the
 * rule that closed #75 is provable by a SHARED contract case instead of by prose.
 *
 * SANDBOX-CLEAN. No `fetch`, no `node:` builtin, no host import.
 */

import {
	cents as toCents,
	currency as toCurrency,
	deleteTaxClass as deleteTaxClassUseCase,
	type CouponListCursor,
	type CouponListFilter,
	type CouponRecord,
	type CouponSummary,
	type CouponType,
	type ShippingMethod,
	type ShippingMethodType,
	type ShippingRate,
	type ShippingZone,
	type TaxClass,
	type TaxRate,
} from "@otta-sh/domain";
import {
	CommerceInputError,
	requireBoundedText,
	requireCurrencyCode,
	requireIdToken,
	requireNonNegativeInteger,
} from "../commerce/commerce-input.js";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
	type InProcessCommerceStoresOptions,
} from "../commerce/in-process-commerce-stores.js";
import type { PluginContext } from "../types.js";
import type {
	AdminRulesSurface,
	CouponEdit,
	CouponInput,
	CouponSummaryWire,
	CouponsListFilter,
	CouponsListResult,
	CouponWire,
	RulesCasUpdateResult,
	RulesCreateResult,
	RulesDeleteResult,
	RulesUpdateResult,
	ShippingMethodEdit,
	ShippingMethodInput,
	ShippingMethodWire,
	ShippingRateEdit,
	ShippingRateInput,
	ShippingRateWire,
	ShippingZoneEdit,
	ShippingZoneInput,
	ShippingZoneWire,
	TaxClassDeleteResult,
	TaxClassEdit,
	TaxClassInput,
	TaxClassWire,
	TaxRateEdit,
	TaxRateInput,
	TaxRateWire,
} from "./admin-rules-surface.js";

/** The coupon-list page bounds (`couponsListQuery`: `min(1).max(100)`, default
 *  25). Mirrored, not imported — the service package goes away. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** The basis-point ceiling the rules bodies carried (`z.number().int().min(0)
 *  .max(100_000)`). Deliberately the WIRE bound, not the port's 0–10000 doc
 *  comment: refusing more than the other transport refuses is still a divergence. */
const MAX_BPS = 100_000;

/** `z.string().min(1).max(200)` — the name/label bound every rules body shares. */
const NAME_MAX = 200;

/** `couponBody.startsAt` / `.expiresAt`: `z.string().min(1).max(64)`. */
const INSTANT_TEXT_MAX = 64;

const SHIPPING_METHOD_TYPES = [
	"flat_rate",
	"free_shipping",
] as const satisfies readonly ShippingMethodType[];

const COUPON_TYPES = ["fixed_amount", "percentage"] as const satisfies readonly CouponType[];

export class InProcessAdminRulesClient implements AdminRulesSurface {
	readonly #stores: InProcessCommerceStores;

	/**
	 * Takes the whole context and constructs the adapters once per client, the
	 * same request-scoped lifecycle the console pages already had. A context with
	 * no document store fails HERE, at construction, naming what is missing.
	 */
	constructor(ctx: PluginContext, options: InProcessCommerceStoresOptions = {}) {
		this.#stores = createInProcessCommerceStores(ctx, options);
	}

	// -- Shipping: zones -------------------------------------------------------

	/** Every zone, unfiltered, in store order — the registry read the console's
	 *  zone level and the tax screen's zone picker both source from. */
	async listZones(): Promise<ShippingZoneWire[]> {
		const zones = await this.#stores.shippingRules.listZones();
		return zones.map(toZoneWire);
	}

	async createZone(input: ShippingZoneInput): Promise<RulesCreateResult<ShippingZoneWire>> {
		requireIdToken("id", input.id);
		requireBoundedText("name", input.name, 1, NAME_MAX);
		const zone = await this.#stores.shippingRules.createZone({
			id: input.id,
			name: input.name,
			regions: input.regions ?? null,
		});
		return { ok: true, value: toZoneWire(zone) };
	}

	/** LWW rename + full-replace of the match list. `regions` is REQUIRED (see the
	 *  class doc): an omitted key is refused, an explicit `null` clears. */
	async updateZone(
		zoneId: string,
		edit: ShippingZoneEdit,
	): Promise<RulesUpdateResult<ShippingZoneWire>> {
		requireIdToken("zoneId", zoneId);
		requireBoundedText("name", edit.name, 1, NAME_MAX);
		requireFullReplaceKey("regions", edit);
		const res = await this.#stores.shippingRules.updateZone(zoneId, {
			name: edit.name,
			regions: edit.regions ?? null,
		});
		return res.ok ? { ok: true, value: toZoneWire(res.zone) } : { ok: false, reason: "not_found" };
	}

	/** Idempotent delete, guarded by the zone's methods: `not_found` is the no-op
	 *  arm, `in_use` the referential refusal (`in_use_by_methods` on the port). */
	async deleteZone(zoneId: string): Promise<RulesDeleteResult> {
		requireIdToken("zoneId", zoneId);
		return toDeleteResult(await this.#stores.shippingRules.deleteZone(zoneId));
	}

	// -- Shipping: methods -----------------------------------------------------

	async listMethods(zoneId: string): Promise<ShippingMethodWire[]> {
		requireIdToken("zoneId", zoneId);
		const methods = await this.#stores.shippingRules.listMethods(zoneId);
		return methods.map(toMethodWire);
	}

	async createMethod(
		zoneId: string,
		input: ShippingMethodInput,
	): Promise<RulesCreateResult<ShippingMethodWire>> {
		requireIdToken("zoneId", zoneId);
		requireIdToken("id", input.id);
		requireBoundedText("name", input.name, 1, NAME_MAX);
		const type = requireShippingMethodType(input.type);
		const method = await this.#stores.shippingRules.createMethod({
			id: input.id,
			// The ZONE IS THE PATH, never the body — a method's parent is identity.
			zoneId,
			name: input.name,
			type,
		});
		return { ok: true, value: toMethodWire(method) };
	}

	/** LWW edit. `zoneId` is immutable identity and is not editable here. */
	async updateMethod(
		methodId: string,
		edit: ShippingMethodEdit,
	): Promise<RulesUpdateResult<ShippingMethodWire>> {
		requireIdToken("methodId", methodId);
		requireBoundedText("name", edit.name, 1, NAME_MAX);
		const type = requireShippingMethodType(edit.type);
		const res = await this.#stores.shippingRules.updateMethod(methodId, {
			name: edit.name,
			type,
		});
		return res.ok
			? { ok: true, value: toMethodWire(res.method) }
			: { ok: false, reason: "not_found" };
	}

	/** Idempotent delete, guarded by the method's rates (`in_use_by_rates`). */
	async deleteMethod(methodId: string): Promise<RulesDeleteResult> {
		requireIdToken("methodId", methodId);
		return toDeleteResult(await this.#stores.shippingRules.deleteMethod(methodId));
	}

	// -- Shipping: rates -------------------------------------------------------

	/** One method's rate in one currency, or `null` when there is none. The
	 *  ASYMMETRY of the HTTP twin is preserved: "no such rate" is `null` (the
	 *  route's 404), and nothing else about this read is an absence. */
	async getRate(methodId: string, currency: string): Promise<ShippingRateWire | null> {
		requireIdToken("methodId", methodId);
		requireCurrencyCode("currency", currency);
		const rate = await this.#stores.shippingRules.getRate(methodId, toCurrency(currency));
		return rate === null ? null : toRateWire(rate);
	}

	async createRate(
		methodId: string,
		input: ShippingRateInput,
	): Promise<RulesCreateResult<ShippingRateWire>> {
		requireIdToken("methodId", methodId);
		requireCurrencyCode("currency", input.currency);
		requireNonNegativeInteger("amountCents", input.amountCents);
		const min = input.minSubtotalCents;
		if (min !== undefined && min !== null) requireNonNegativeInteger("minSubtotalCents", min);
		const rate = await this.#stores.shippingRules.createRate({
			methodId,
			currency: toCurrency(input.currency),
			amountCents: toCents(input.amountCents),
			// Money stays an integer minor unit, branded at this boundary.
			minSubtotalCents: min === undefined || min === null ? null : toCents(min),
		});
		return { ok: true, value: toRateWire(rate) };
	}

	/**
	 * CAS edit on the money-bearing `amountCents`. `expectedAmountCents` IS the
	 * amount the admin read — the token is the value, not a version — so a
	 * concurrent edit answers `stale` carrying the fresh row instead of clobbering
	 * it. `minSubtotalCents` is the required-nullable full-replace key.
	 */
	async updateRate(
		methodId: string,
		currency: string,
		edit: ShippingRateEdit,
	): Promise<RulesCasUpdateResult<ShippingRateWire>> {
		requireIdToken("methodId", methodId);
		requireCurrencyCode("currency", currency);
		requireNonNegativeInteger("amountCents", edit.amountCents);
		requireNonNegativeInteger("expectedAmountCents", edit.expectedAmountCents);
		requireFullReplaceKey("minSubtotalCents", edit);
		if (edit.minSubtotalCents !== null) {
			requireNonNegativeInteger("minSubtotalCents", edit.minSubtotalCents);
		}
		const res = await this.#stores.shippingRules.updateRate(
			methodId,
			toCurrency(currency),
			{
				amountCents: toCents(edit.amountCents),
				minSubtotalCents: edit.minSubtotalCents === null ? null : toCents(edit.minSubtotalCents),
			},
			toCents(edit.expectedAmountCents),
		);
		if (res.ok) return { ok: true, value: toRateWire(res.rate) };
		if (res.reason === "not_found") return { ok: false, reason: "not_found" };
		return { ok: false, reason: "stale", current: toRateWire(res.current) };
	}

	/** A LEAF delete: idempotent, and it NEVER answers `in_use` — nothing
	 *  references a rate row, and an order's totals were snapshotted at creation,
	 *  so removing a rate never rewrites an existing order. */
	async deleteRate(methodId: string, currency: string): Promise<RulesDeleteResult> {
		requireIdToken("methodId", methodId);
		requireCurrencyCode("currency", currency);
		const res = await this.#stores.shippingRules.deleteRate(methodId, toCurrency(currency));
		return res.ok ? { ok: true } : { ok: false, reason: "not_found" };
	}

	// -- Tax: classes ----------------------------------------------------------

	async listTaxClasses(): Promise<TaxClassWire[]> {
		const classes = await this.#stores.taxRules.listClasses();
		return classes.map(toTaxClassWire);
	}

	async createTaxClass(input: TaxClassInput): Promise<RulesCreateResult<TaxClassWire>> {
		requireIdToken("id", input.id);
		requireBoundedText("name", input.name, 1, NAME_MAX);
		const cls = await this.#stores.taxRules.createClass({ id: input.id, name: input.name });
		return { ok: true, value: toTaxClassWire(cls) };
	}

	/** LWW rename. A class id is the referent rates and products point at, so a
	 *  rename orphans nothing and needs no CAS (the row carries no money). */
	async updateTaxClass(
		classId: string,
		edit: TaxClassEdit,
	): Promise<RulesUpdateResult<TaxClassWire>> {
		requireIdToken("classId", classId);
		requireBoundedText("name", edit.name, 1, NAME_MAX);
		const res = await this.#stores.taxRules.updateClass(classId, { name: edit.name });
		return res.ok
			? { ok: true, value: toTaxClassWire(res.class) }
			: { ok: false, reason: "not_found" };
	}

	/**
	 * Delete a tax class — the ONE delete on this surface composed over TWO
	 * aggregates, and the reason it has a result type of its own.
	 *
	 * The `deleteTaxClass` use-case spans the PRODUCT aggregate (`productCommerce.
	 * countByTaxClass`, checked first) and the TAX aggregate (`taxRules.
	 * deleteClass`, whose own atomic guard knows only "≥1 rate" and is followed by
	 * `countRatesByClass` for the honest number). Each refusal therefore carries a
	 * `count`, so the console can say "3 products reference this class" rather than
	 * the generic screens' "in use, delete the children first".
	 */
	async deleteTaxClass(classId: string): Promise<TaxClassDeleteResult> {
		requireIdToken("classId", classId);
		const res = await deleteTaxClassUseCase(
			{
				taxRules: this.#stores.taxRules,
				productCommerce: this.#stores.productCommerce,
			},
			classId,
		);
		if (res.ok) return { ok: true };
		if (res.reason === "not_found") return { ok: false, reason: "not_found" };
		if (res.reason === "in_use_by_products") {
			return { ok: false, reason: "in_use_by_products", count: res.count };
		}
		return { ok: false, reason: "in_use_by_rates", count: res.count };
	}

	// -- Tax: rates ------------------------------------------------------------

	async listTaxRates(zoneId: string): Promise<TaxRateWire[]> {
		requireIdToken("zoneId", zoneId);
		const rates = await this.#stores.taxRules.listRatesForZone(zoneId);
		return rates.map(toTaxRateWire);
	}

	async createTaxRate(input: TaxRateInput): Promise<RulesCreateResult<TaxRateWire>> {
		requireIdToken("id", input.id);
		requireIdToken("taxClassId", input.taxClassId);
		requireIdToken("zoneId", input.zoneId);
		requireBps("rateBps", input.rateBps);
		const rate = await this.#stores.taxRules.createRate({
			id: input.id,
			taxClassId: input.taxClassId,
			zoneId: input.zoneId,
			rateBps: input.rateBps,
			// The CREATE's optional-default-false is deliberate and unlike the edit's
			// required key: there is no prior value to clobber at creation.
			appliesToShipping: input.appliesToShipping ?? false,
		});
		return { ok: true, value: toTaxRateWire(rate) };
	}

	/** CAS edit on the money-bearing `rateBps` (`expectedRateBps` is the rate the
	 *  admin read). `appliesToShipping` is the required full-replace key. */
	async updateTaxRate(
		rateId: string,
		edit: TaxRateEdit,
	): Promise<RulesCasUpdateResult<TaxRateWire>> {
		requireIdToken("rateId", rateId);
		requireBps("rateBps", edit.rateBps);
		requireBps("expectedRateBps", edit.expectedRateBps);
		requireFullReplaceKey("appliesToShipping", edit);
		if (typeof edit.appliesToShipping !== "boolean") {
			throw new CommerceInputError("appliesToShipping", "must be a boolean");
		}
		const res = await this.#stores.taxRules.updateRate(
			rateId,
			{ rateBps: edit.rateBps, appliesToShipping: edit.appliesToShipping },
			edit.expectedRateBps,
		);
		if (res.ok) return { ok: true, value: toTaxRateWire(res.rate) };
		if (res.reason === "not_found") return { ok: false, reason: "not_found" };
		return { ok: false, reason: "stale", current: toTaxRateWire(res.current) };
	}

	/** A LEAF delete: idempotent, never `in_use` — same snapshot invariant as the
	 *  shipping rate's. */
	async deleteTaxRate(rateId: string): Promise<RulesDeleteResult> {
		requireIdToken("rateId", rateId);
		const res = await this.#stores.taxRules.deleteRate(rateId);
		return res.ok ? { ok: true } : { ok: false, reason: "not_found" };
	}

	// -- Coupons ---------------------------------------------------------------

	/**
	 * The admin Coupons page, its EXACT total, and the cursor for the next one.
	 *
	 * EITHER a fresh `filter` OR a previous page's `opts.cursor`, never both — the
	 * token already embeds the active filter, and this surface takes the predicate
	 * SOLELY from the token when one is present, exactly as the route does. (That
	 * is narrower than the orders/products lists, which additionally fail closed on
	 * a token whose filter disagrees with the caller's; the divergence is the
	 * route's and is ported rather than quietly fixed on one tier only.)
	 *
	 * A malformed/tampered token REJECTS, because the route answers 400 and the
	 * HTTP client throws on it.
	 */
	async listCoupons(
		filter: CouponsListFilter,
		opts: { cursor?: string; limit?: number } = {},
	): Promise<CouponsListResult> {
		const askedLimit = requireLimit(opts.limit);
		const token = opts.cursor !== undefined && opts.cursor.length > 0 ? opts.cursor : null;

		let active: CouponListFilter;
		let pos: CouponListCursor | null;
		let limit: number;
		if (token === null) {
			active = toDomainFilter(filter);
			pos = null;
			limit = askedLimit;
		} else {
			const decoded = decodeCouponCursor(token);
			const decodedPos = decoded === null ? null : couponCursorPosOf(decoded.pos);
			const decodedFilter = decoded === null ? null : revalidateFilter(decoded.filter);
			if (decoded === null || decodedPos === null || decodedFilter === null) {
				throw new CommerceInputError("cursor", "must be a cursor this surface issued");
			}
			active = decodedFilter;
			pos = decodedPos;
			limit = clampLimit(decoded.limit, askedLimit);
		}

		// The page and its EXACT count, under ONE filter, in parallel — sharing the
		// filter is what lets the count describe the page it captions.
		const [result, total] = await Promise.all([
			this.#stores.couponStore.listCoupons(active, { cursor: pos, limit }),
			this.#stores.couponStore.countCoupons(active),
		]);
		return {
			coupons: result.coupons.map(toCouponSummaryWire),
			nextCursor:
				result.nextCursor === null ? null : encodeCouponCursor(result.nextCursor, active, limit),
			total,
		};
	}

	/** One coupon by CODE, or `null` when there is none — the same 404-is-an-
	 *  absence asymmetry `getRate` keeps. The detail projection deliberately omits
	 *  the validity window (the list row carries it). */
	async getCoupon(code: string): Promise<CouponWire | null> {
		requireBoundedText("code", code, 1, NAME_MAX);
		const coupon = await this.#stores.couponStore.findByCode(code);
		return coupon === null ? null : toCouponWire(coupon);
	}

	async createCoupon(input: CouponInput): Promise<RulesCreateResult<CouponWire>> {
		requireIdToken("id", input.id);
		requireBoundedText("code", input.code, 1, NAME_MAX);
		const type = requireCouponType(input.type);
		const amountCents = optionalNonNegative("amountCents", input.amountCents);
		const rateBps = optionalBps("rateBps", input.rateBps);
		const capCents = optionalNonNegative("capCents", input.capCents);
		const minSubtotalCents = optionalNonNegative("minSubtotalCents", input.minSubtotalCents);
		const maxUses = optionalNonNegative("maxUses", input.maxUses);
		const maxUsesPerCustomer = optionalNonNegative("maxUsesPerCustomer", input.maxUsesPerCustomer);
		const startsAt = optionalInstantText("startsAt", input.startsAt);
		const expiresAt = optionalInstantText("expiresAt", input.expiresAt);
		if (input.currency !== undefined && input.currency !== null) {
			requireCurrencyCode("currency", input.currency);
		}
		const coupon = await this.#stores.couponStore.create({
			id: input.id,
			code: input.code,
			type,
			amountCents: amountCents === null ? null : toCents(amountCents),
			rateBps,
			capCents: capCents === null ? null : toCents(capCents),
			currency:
				input.currency === undefined || input.currency === null ? null : toCurrency(input.currency),
			minSubtotalCents: minSubtotalCents === null ? null : toCents(minSubtotalCents),
			startsAt,
			expiresAt,
			maxUses,
			maxUsesPerCustomer,
		});
		return { ok: true, value: toCouponWire(coupon) };
	}

	/**
	 * LWW edit of the economics and the validity window. This is the ONE
	 * intentional omit-⇒-null partial on this surface: every editable field is
	 * nullable in the port, so "absent" and "null" both mean "this axis is unset"
	 * — unlike the zone/rate edits, where an omitted required key would destroy
	 * meaningful config and is refused.
	 *
	 * FETCH-THEN-VALIDATE, ported from the route (issue #75): `type` is the
	 * coupon's immutable kind and is NOT on the edit body, so the only way to know
	 * which economic axis is mandatory is to read the coupon first. A blanked axis
	 * is refused BEFORE any write, with the same typed refusal the wire produces.
	 */
	async updateCoupon(couponId: string, edit: CouponEdit): Promise<RulesUpdateResult<CouponWire>> {
		requireIdToken("couponId", couponId);
		const amountCents = optionalNonNegative("amountCents", edit.amountCents);
		const rateBps = optionalBps("rateBps", edit.rateBps);
		const capCents = optionalNonNegative("capCents", edit.capCents);
		const minSubtotalCents = optionalNonNegative("minSubtotalCents", edit.minSubtotalCents);
		const maxUses = optionalNonNegative("maxUses", edit.maxUses);
		const maxUsesPerCustomer = optionalNonNegative("maxUsesPerCustomer", edit.maxUsesPerCustomer);
		const startsAt = optionalInstantText("startsAt", edit.startsAt);
		const expiresAt = optionalInstantText("expiresAt", edit.expiresAt);

		const existing = await this.#stores.couponStore.findById(couponId);
		if (existing === null) return { ok: false, reason: "not_found" };
		if (
			(existing.type === "fixed_amount" && amountCents === null) ||
			(existing.type === "percentage" && rateBps === null)
		) {
			// The route's 400, as the HTTP client renders it. NOT a rejection: this is
			// ported route behaviour rather than a boundary shape check, so both tiers
			// answer it identically and a shared case can pin it.
			return { ok: false, reason: "error", status: 400 };
		}

		const res = await this.#stores.couponStore.update(couponId, {
			amountCents: amountCents === null ? null : toCents(amountCents),
			rateBps,
			capCents: capCents === null ? null : toCents(capCents),
			minSubtotalCents: minSubtotalCents === null ? null : toCents(minSubtotalCents),
			startsAt,
			expiresAt,
			maxUses,
			maxUsesPerCustomer,
		});
		return res.ok
			? { ok: true, value: toCouponWire(res.coupon) }
			: { ok: false, reason: "not_found" };
	}

	/** Idempotent delete, guarded by live redemptions (`in_use_by_redemptions`) —
	 *  a redeemed coupon is history an order's totals point at. */
	async deleteCoupon(couponId: string): Promise<RulesDeleteResult> {
		requireIdToken("couponId", couponId);
		return toDeleteResult(await this.#stores.couponStore.delete(couponId));
	}
}

// ── the wire projections, field for field ─────────────────────────────────

function toZoneWire(zone: ShippingZone): ShippingZoneWire {
	return { id: zone.id, name: zone.name, regions: zone.regions };
}

function toMethodWire(method: ShippingMethod): ShippingMethodWire {
	return { id: method.id, zoneId: method.zoneId, name: method.name, type: method.type };
}

/** Money on the wire is an integer minor `amountCents` plus its ISO-4217
 *  currency — never a float, and `minSubtotalCents: null` means "no free-shipping
 *  threshold", never zero. */
function toRateWire(rate: ShippingRate): ShippingRateWire {
	return {
		methodId: rate.methodId,
		currency: rate.currency,
		amountCents: rate.amountCents,
		minSubtotalCents: rate.minSubtotalCents,
	};
}

function toTaxClassWire(cls: TaxClass): TaxClassWire {
	return { id: cls.id, name: cls.name };
}

function toTaxRateWire(rate: TaxRate): TaxRateWire {
	return {
		id: rate.id,
		taxClassId: rate.taxClassId,
		zoneId: rate.zoneId,
		rateBps: rate.rateBps,
		appliesToShipping: rate.appliesToShipping,
	};
}

/** `serializeCoupon`'s twin — and it OMITS `startsAt`/`expiresAt` on purpose, as
 *  that serializer does. The list row carries the window; unifying the two shapes
 *  would change what the detail read means. */
function toCouponWire(coupon: CouponRecord): CouponWire {
	return {
		id: coupon.id,
		code: coupon.code,
		type: coupon.type,
		amountCents: coupon.amountCents,
		rateBps: coupon.rateBps,
		capCents: coupon.capCents,
		currency: coupon.currency,
		minSubtotalCents: coupon.minSubtotalCents,
		maxUses: coupon.maxUses,
		maxUsesPerCustomer: coupon.maxUsesPerCustomer,
		usesCount: coupon.usesCount,
	};
}

/** `serializeCouponSummary`'s twin — every detail field PLUS the validity window
 *  and `createdAt`, because the console list renders expiry straight off the row
 *  rather than fetching each coupon's detail. */
function toCouponSummaryWire(summary: CouponSummary): CouponSummaryWire {
	return {
		id: summary.id,
		code: summary.code,
		type: summary.type,
		amountCents: summary.amountCents,
		rateBps: summary.rateBps,
		capCents: summary.capCents,
		currency: summary.currency,
		minSubtotalCents: summary.minSubtotalCents,
		startsAt: summary.startsAt,
		expiresAt: summary.expiresAt,
		maxUses: summary.maxUses,
		maxUsesPerCustomer: summary.maxUsesPerCustomer,
		usesCount: summary.usesCount,
		createdAt: summary.createdAt,
	};
}

/** The three PARENT deletes share one mapping: the port's own `in_use_by_*`
 *  reason collapses to the wire's single `in_use`, and `not_found` stays the
 *  idempotent no-op. The leaf deletes do NOT go through here — they have no
 *  referential arm at all. */
function toDeleteResult(res: { ok: true } | { ok: false; reason: string }): RulesDeleteResult {
	if (res.ok) return { ok: true };
	return res.reason === "not_found"
		? { ok: false, reason: "not_found" }
		: { ok: false, reason: "in_use" };
}

// ── the input bounds the request schemas used to hold ─────────────────────

/**
 * A full-replace key that must be SPELLED OUT.
 *
 * The wire schemas make `regions` / `minSubtotalCents` / `appliesToShipping`
 * required precisely so an omitted key is a refusal rather than a silent wipe of
 * the zone's match list, the free-shipping threshold or the shipping-tax
 * behaviour. There is no zod here to enforce it, so this does — `undefined` NEVER
 * means "leave unchanged" on these edits; an explicit `null`/`false` clears.
 */
function requireFullReplaceKey(field: string, edit: object): void {
	if (!Object.hasOwn(edit, field) || (edit as Record<string, unknown>)[field] === undefined) {
		throw new CommerceInputError(field, "is required (send an explicit value to replace it)");
	}
}

function requireShippingMethodType(value: string): ShippingMethodType {
	if (!SHIPPING_METHOD_TYPES.includes(value as ShippingMethodType)) {
		throw new CommerceInputError("type", "must be flat_rate or free_shipping");
	}
	return value as ShippingMethodType;
}

function requireCouponType(value: string): CouponType {
	if (!COUPON_TYPES.includes(value as CouponType)) {
		throw new CommerceInputError("type", "must be fixed_amount or percentage");
	}
	return value as CouponType;
}

/** Integer basis points within the WIRE bound. */
function requireBps(field: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BPS) {
		throw new CommerceInputError(field, `must be an integer between 0 and ${String(MAX_BPS)}`);
	}
	return value;
}

/** An `int().nonnegative().nullable().optional()` field: absent and null are the
 *  same "unset", and anything present must be a non-negative integer. */
function optionalNonNegative(field: string, value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	return requireNonNegativeInteger(field, value);
}

function optionalBps(field: string, value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	return requireBps(field, value);
}

/** `z.string().min(1).max(64).nullable().optional()` — the coupon window bounds.
 *  Deliberately NOT an instant parse: the wire never parsed one either, and
 *  refusing more than the other transport refuses is still a divergence. */
function optionalInstantText(field: string, value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	return requireBoundedText(field, value, 1, INSTANT_TEXT_MAX);
}

/** The page size the caller asked for, bounded as the query schema bounded it.
 *  Absent ⇒ the schema's own default. */
function requireLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new CommerceInputError("limit", `must be an integer between 1 and ${String(MAX_LIMIT)}`);
	}
	return limit;
}

/** The caller's filter as a domain `CouponListFilter`. An EMPTY value is an
 *  ABSENT axis, not an empty one — the HTTP client omits a zero-length `search`
 *  from its query string entirely. */
function toDomainFilter(filter: CouponsListFilter): CouponListFilter {
	const out: CouponListFilter = {};
	if (filter.search !== undefined && filter.search.length > 0) {
		out.search = requireBoundedText("search", filter.search, 1, NAME_MAX);
	}
	return out;
}

// ── the opaque cursor, ported from the route ──────────────────────────────

interface DecodedCouponCursor {
	pos: unknown;
	filter: unknown;
	limit: unknown;
}

function encodeCouponCursor(
	pos: CouponListCursor,
	filter: CouponListFilter,
	limit: number,
): string {
	const payload = { pos: { createdAt: pos.createdAt, couponId: pos.couponId }, filter, limit };
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode a token; `null` on ANY malformed/tampered/garbage input, so a bad token
 *  is a refusal rather than a throw from inside `atob`. */
function decodeCouponCursor(token: string): DecodedCouponCursor | null {
	try {
		const json = new TextDecoder().decode(fromBase64Url(token));
		const parsed = JSON.parse(json) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const p = parsed as DecodedCouponCursor;
		return { pos: p.pos, filter: p.filter, limit: p.limit };
	} catch {
		return null;
	}
}

/** Exactly what `z.string().datetime()` accepts — the validator the route's own
 *  cursor schema puts in front of the position's instant. Mirrored rather than
 *  approximated: the value is compared LEXICOGRAPHICALLY by the store's keyset
 *  predicate, so a real instant that is not `toISOString()`-shaped would page
 *  from somewhere the operator never asked for. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** `couponCursorPosOf`'s twin: `{ createdAt: <ISO instant>, couponId: <opaque,
 *  bounded> }`, or null when malformed. */
function couponCursorPosOf(pos: unknown): CouponListCursor | null {
	if (pos === null || typeof pos !== "object") return null;
	const p = pos as { createdAt?: unknown; couponId?: unknown };
	if (typeof p.createdAt !== "string" || !ISO_INSTANT.test(p.createdAt)) return null;
	if (Number.isNaN(Date.parse(p.createdAt))) return null;
	if (typeof p.couponId !== "string" || p.couponId.length === 0 || p.couponId.length > 200) {
		return null;
	}
	return { createdAt: p.createdAt, couponId: p.couponId };
}

/** RE-VALIDATE the decoded filter before trusting it — the token is
 *  operator-round-trippable input like any other. An unknown axis is a refusal
 *  here (the same narrower-on-purpose stance the products/orders clients take),
 *  because a non-strict re-parse would silently drop it and serve a page under a
 *  predicate that is not the one the token claimed. */
function revalidateFilter(filter: unknown): CouponListFilter | null {
	if (filter === null || typeof filter !== "object") return null;
	const f = filter as Record<string, unknown>;
	for (const key of Object.keys(f)) {
		if (key !== "search") return null;
	}
	const out: CouponListFilter = {};
	if (f["search"] !== undefined) {
		const search = f["search"];
		if (typeof search !== "string" || search.length === 0 || search.length > NAME_MAX) return null;
		out.search = search;
	}
	return out;
}

/** Clamp a decoded limit into [1, 100] — a token's limit is RE-CLAMPED, never
 *  honoured past the max. Falls back to the caller's own bounded limit. */
function clampLimit(decoded: unknown, askedLimit: number): number {
	const raw = typeof decoded === "number" && Number.isFinite(decoded) ? decoded : askedLimit;
	return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

// Portable base64url (Node + workerd both provide btoa/atob + TextEncoder).
function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
	const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64); // throws on invalid base64 ⇒ caught by decodeCouponCursor
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
