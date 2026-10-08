/**
 * What the Pricing & stock cards decide, as pure functions (ADR-0014, amendment
 * 2026-10-01).
 *
 * The cards sit in the product editor's main column and edit the
 * commerce fields the retired Pricing & inventory page used to: price,
 * compare-at, cost, SKU, product type, tax class, weight and size. Everything it
 * DECIDES about them — what the inputs show, when the form is dirty, what is
 * wrong with a value, what a save sends — lives here, so the decisions are
 * tested without a document and the component only wires them up.
 *
 * MONEY IS NEVER A FLOAT HERE. Amounts are parsed to integer minor units by the
 * shared `parseMinorUnitsInput` and rendered by the shared `formatAmount`; the
 * only division is the margin PERCENTAGE, which is not money.
 *
 * THE COPY IS WRITTEN FOR A SHOP OWNER, not an operator: "Enter a price like
 * 24.99", "Add a price first". The plugin still re-validates every value and
 * answers in its own words; this layer only stops an obviously wrong save from
 * leaving the browser.
 */
import {
	CURRENCY_CHOICES,
	DEFAULT_STORE_CURRENCY,
	currencyChoiceLabel,
	formatAmount,
	formatMinorUnitsInput,
	isSupportedCurrency,
	moneyInputExample,
	parseMinorUnitsInput,
} from "@otta-sh/admin-presentation";
import type { ProductRecord } from "../console-api.js";

/** Offered when a product has no price yet: EVERY currency in the shared
 *  currency table, the familiar ten first and the rest by code (the order the
 *  Settings page's store-currency select uses too). Each is typed and stored in
 *  its own minor unit (JPY in whole yen, KWD in fils), so any of them prices
 *  correctly. The label (`currencyChoiceLabel`) carries #438's checkout warning. */
export { CURRENCY_CHOICES, currencyChoiceLabel };

/** Every input the panel owns, as the text in the field. */
export interface PricingDraft {
	readonly price: string;
	readonly currency: string;
	readonly compareAt: string;
	readonly unitCost: string;
	readonly sku: string;
	readonly productKind: string;
	readonly taxClass: string;
	readonly taxStatus: string;
	readonly weightGrams: string;
	readonly lengthMm: string;
	readonly widthMm: string;
	readonly heightMm: string;
}

export type DraftField = keyof PricingDraft;

/** Per-field problems, in the merchant's words. Empty when the draft can save. */
export type DraftProblems = Partial<Record<DraftField, string>>;

function moneyText(minorUnits: number | null, currency: string): string {
	return minorUnits === null ? "" : formatMinorUnitsInput(minorUnits, currency);
}

function countText(n: number | null): string {
	return n === null ? "" : String(n);
}

/** `storeCurrency` is what an UNPRICED product's picker starts on: the store
 *  currency the detail read carried, the never-saved `DEFAULT_STORE_CURRENCY`
 *  when it had none, and `""` (nothing chosen) when the read failed. */
export function draftFromRecord(
	p: ProductRecord,
	storeCurrency: string = DEFAULT_STORE_CURRENCY,
): PricingDraft {
	const currency = p.currency ?? storeCurrency;
	return {
		price: moneyText(p.priceCents, currency),
		currency,
		compareAt: moneyText(p.compareAtCents, currency),
		unitCost: moneyText(p.unitCostCents, currency),
		sku: p.sku ?? "",
		productKind: p.productKind,
		taxClass: p.taxClass ?? "",
		taxStatus: p.taxStatus ?? "taxable",
		weightGrams: countText(p.weightGrams),
		lengthMm: countText(p.lengthMm),
		widthMm: countText(p.widthMm),
		heightMm: countText(p.heightMm),
	};
}

const MONEY_FIELDS = new Set<DraftField>(["price", "compareAt", "unitCost"]);

/** A value as it will be SENT: money canonicalised in its currency (`32` →
 *  `32.00` for USD, `1500` stays `1500` for JPY), text trimmed. Two drafts are
 *  equal when they would send the same thing. */
function canonical(field: DraftField, value: string, currency: string): string {
	const trimmed = value.trim();
	if (!MONEY_FIELDS.has(field)) return trimmed;
	const units = parseMinorUnitsInput(trimmed, currency, { allowZero: true });
	return units === null ? trimmed : formatMinorUnitsInput(units, currency);
}

function changedFields(saved: PricingDraft, draft: PricingDraft): DraftField[] {
	return (Object.keys(saved) as DraftField[]).filter((field) => {
		// The currency only travels WITH a price: picked on its own for a product
		// that has none, the save would send nothing, so it is not a change.
		if (field === "currency" && draft.price.trim().length === 0) return false;
		// Nor is a weight or size typed before switching to digital: it is not sent.
		if (draft.productKind === "digital" && SIZE_FIELDS.has(field)) return false;
		return (
			canonical(field, saved[field], saved.currency) !==
			canonical(field, draft[field], draft.currency)
		);
	});
}

export function isDraftDirty(saved: PricingDraft, draft: PricingDraft): boolean {
	return changedFields(saved, draft).length > 0;
}

/** A currency move a re-read brought under money the merchant entered. */
export interface CurrencyChange {
	/** The currency the merchant's amounts were entered in (`""`: none chosen). */
	readonly from: string;
	/** The product's effective currency now. */
	readonly to: string;
}

/**
 * THE CURRENCY RULE for a re-read under a form the merchant may have used.
 *
 * "Money typed" means the merchant CHANGED a money field (price, compare-at,
 * unit cost) from the record they loaded — compared canonically, so a seeded
 * price does not count — or explicitly picked a currency.
 *  - No money typed: the currency follows the newer record — its stored
 *    currency if priced, else the newer store currency (`""` while unknown).
 *  - Money typed: the currency stays what the merchant saw. If the context they
 *    priced against moved under them — the product was priced elsewhere in
 *    another currency, or the default they were on moved (a store switch, or
 *    unknown becoming known) — it is a CONFLICT, reported with what changed:
 *    never a silent change of currency or amounts.
 */
export function resolveDraftCurrency(args: {
	/** The draft as the merchant left it. */
	draft: PricingDraft;
	/** The draft the form was loaded with (`draftFromRecord(previous, …)`). */
	before: PricingDraft;
	previous: ProductRecord;
	/** The store currency the form was seeded with. */
	storeCurrency: string;
	/** Set only by a UI pick of the currency select. */
	picked: boolean;
	next: ProductRecord;
	/** The store currency the newer read carried (`""`: still unknown). */
	nextStoreCurrency: string;
}): { currency: string; change: CurrencyChange | null } {
	const { draft, before, previous, storeCurrency, picked, next, nextStoreCurrency } = args;
	const moneyTyped =
		picked ||
		[...MONEY_FIELDS].some(
			(field) =>
				canonical(field, before[field], before.currency) !==
				canonical(field, draft[field], draft.currency),
		);
	const shown = previous.currency ?? storeCurrency;
	const now = next.currency ?? nextStoreCurrency;
	if (!moneyTyped) return { currency: now, change: null };
	// The merchant priced against `shown` (or a pick of their own). It is a
	// change only when the context really moved AND it no longer matches their
	// currency — and a pick is not undone by a moved DEFAULT, only by the product
	// being priced elsewhere.
	const moved =
		now !== shown && now !== draft.currency && (draft.currency === shown || next.currency !== null);
	return { currency: draft.currency, change: moved ? { from: draft.currency, to: now } : null };
}

/** The banner for a {@link CurrencyChange}: what changed, and what to do. */
export function currencyChangeText(change: CurrencyChange): string {
	return change.from === ""
		? `This product's currency is now ${change.to} — choose its currency and check your amounts before saving.`
		: `This product's currency is now ${change.to} — your amounts were entered in ${change.from}. Check them before saving.`;
}

/**
 * A re-read the merchant did not ask for (a CMS save, a stock movement, a
 * refusal that declined a value) lands a NEWER record under a form they may
 * have typed into. Only the fields THEY changed survive it; every other field
 * takes the newer value, so a save never writes a stale value back over someone
 * else's change under the fresh watermark. A field they changed that ALSO
 * changed in the store is a conflict: the store's value wins FOR THAT FIELD and
 * the merchant is told, because neither edit can be assumed to be the one they
 * want; their other edits stay. The CURRENCY follows {@link resolveDraftCurrency}.
 */
export function mergeDraft(
	previous: ProductRecord,
	next: ProductRecord,
	draft: PricingDraft,
	opts: {
		/** The store currency the form was seeded with. */
		storeCurrency?: string;
		/** The store currency the NEWER read carried; defaults to `storeCurrency`. */
		nextStoreCurrency?: string;
		/** The merchant picked the currency in the UI. */
		currencyPicked?: boolean;
	} = {},
): { draft: PricingDraft; conflict: boolean; currencyChange?: CurrencyChange } {
	const storeCurrency = opts.storeCurrency ?? DEFAULT_STORE_CURRENCY;
	const nextStoreCurrency = opts.nextStoreCurrency ?? storeCurrency;
	const before = draftFromRecord(previous, storeCurrency);
	const after = draftFromRecord(next, nextStoreCurrency);
	const mine = changedFields(before, draft).filter((field) => field !== "currency");
	// A clash takes the store's value for THAT field; the merchant's other edits
	// survive, so a conflict on the weight does not throw away a typed price.
	const merged: Record<string, string> = { ...after };
	let conflict = false;
	for (const field of mine) {
		if (
			canonical(field, before[field], before.currency) !==
			canonical(field, after[field], after.currency)
		) {
			conflict = true;
		} else merged[field] = draft[field];
	}
	const currency = resolveDraftCurrency({
		draft,
		before,
		previous,
		storeCurrency,
		picked: opts.currencyPicked === true,
		next,
		nextStoreCurrency,
	});
	merged["currency"] = currency.currency;
	return {
		draft: merged as unknown as PricingDraft,
		conflict: conflict || currency.change !== null,
		// Present only when the currency moved, so existing callers see the shape
		// they always did.
		...(currency.change !== null ? { currencyChange: currency.change } : {}),
	};
}

function money(value: string, currency: string): number | null | "invalid" {
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return parseMinorUnitsInput(trimmed, currency, { allowZero: false }) ?? "invalid";
}

/** Weight and size: hidden, unchecked and unsent for a digital product. */
export const SIZE_FIELDS: ReadonlySet<DraftField> = new Set<DraftField>([
	"weightGrams",
	"lengthMm",
	"widthMm",
	"heightMm",
]);

/** Fields the plugin's save reads as "keep" when sent blank — so a blank one
 *  over a stored value would answer "Saved" and change nothing. */
const UNCLEARABLE: ReadonlyArray<readonly [DraftField, (p: ProductRecord) => boolean, string]> = [
	[
		"price",
		(p) => p.priceCents !== null,
		"A product that has a price needs one — enter the new price",
	],
	["sku", (p) => p.sku !== null, "A SKU can be changed but not removed"],
	["weightGrams", (p) => p.weightGrams !== null, "Can be changed but not removed"],
	["lengthMm", (p) => p.lengthMm !== null, "Can be changed but not removed"],
	["widthMm", (p) => p.widthMm !== null, "Can be changed but not removed"],
	["heightMm", (p) => p.heightMm !== null, "Can be changed but not removed"],
];

export function validateDraft(d: PricingDraft, p: ProductRecord): DraftProblems {
	const problems: DraftProblems = {};
	// Amounts are read in the currency the save will send: the stored one, or —
	// for a first pricing — the one picked beside the price.
	const currency = p.currency ?? d.currency;
	const price = money(d.price, currency);
	const compareAt = money(d.compareAt, currency);
	const unitCost = money(d.unitCost, currency);
	if (price === "invalid")
		problems.price = `Enter a price like ${moneyInputExample("24.99", currency)}`;
	if (compareAt === "invalid") {
		problems.compareAt = `Enter a price like ${moneyInputExample("39.99", currency)}`;
	}
	if (unitCost === "invalid") {
		problems.unitCost = `Enter an amount like ${moneyInputExample("9.50", currency)}`;
	}
	if (price === null && (compareAt !== null || unitCost !== null)) {
		problems.price = "Add a price first";
	}
	// A first pricing AUTHORS the currency, so it must be one the store
	// supports; a stored one (even one written before the table) is never
	// questioned, or an old product could not be edited at all.
	if (p.currency === null && price !== null && !isSupportedCurrency(d.currency)) {
		problems.currency = "Choose a supported currency";
	}
	if (typeof price === "number" && typeof compareAt === "number" && compareAt <= price) {
		problems.compareAt = "Must be higher than the price to show a sale";
	}
	// A digital product ships nothing: its weight and size are neither shown nor
	// sent (see `savePayload`), so they are not checked either.
	const physical = d.productKind !== "digital";
	for (const field of ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const) {
		if (!physical) break;
		const v = d[field].trim();
		if (v.length > 0 && !/^\d+$/.test(v)) problems[field] = "Use a whole number";
	}
	for (const [field, stored, message] of UNCLEARABLE) {
		if (!physical && SIZE_FIELDS.has(field)) continue;
		if (d[field].trim().length === 0 && stored(p)) problems[field] = message;
	}
	return problems;
}

/** Profit and margin per item, or `null` until both a price and a cost exist. */
export function marginSummary(
	price: string,
	unitCost: string,
	currency: string,
): { profit: string; margin: string } | null {
	const p = money(price, currency);
	const c = money(unitCost, currency);
	if (typeof p !== "number" || typeof c !== "number") return null;
	const profit = p - c;
	const percent = Math.round((profit / p) * 100);
	return {
		profit: formatAmount(profit, currency),
		margin: percent < 0 ? `−${String(Math.abs(percent))}%` : `${String(percent)}%`,
	};
}

/** How a sale will read on the store — the "was" and the "now" — or `null`
 *  when the compare-at price does not make one. */
export function salePreview(
	price: string,
	compareAt: string,
	currency: string,
): { was: string; now: string } | null {
	const p = money(price, currency);
	const c = money(compareAt, currency);
	if (typeof p !== "number" || typeof c !== "number" || c <= p) return null;
	return { was: formatAmount(c, currency), now: formatAmount(p, currency) };
}

export type StockTone = "ok" | "warn" | "fail" | "none";

/** The badge beside the count. `null` on-hand is "no inventory record" —
 *  unknown, never zero. A store with no low-stock threshold warns only at 0. */
export function stockStatus(
	onHand: number | null,
	threshold: number | null,
): { tone: StockTone; label: string } {
	if (onHand === null) return { tone: "none", label: "Not tracked" };
	if (onHand <= 0) return { tone: "fail", label: "Out of stock" };
	if (threshold !== null && onHand <= threshold) return { tone: "warn", label: "Low stock" };
	return { tone: "ok", label: "In stock" };
}

/**
 * The one save. EVERY field the panel owns rides with it. Blank means "clear"
 * for compare-at, cost and tax class, and "keep" for price, SKU, weight and size
 * — which is why `validateDraft` refuses a blank one of those over a stored
 * value. The watermark is the record the panel last loaded; the plugin refuses
 * the save if the product moved since.
 *
 * No `title` and no `active`: both are the CMS's (ADR-0013).
 */
export function savePayload(p: ProductRecord, d: PricingDraft): Record<string, string> {
	return {
		productId: p.productId,
		expectedUpdatedAt: p.updatedAt,
		sku: d.sku.trim(),
		price: canonical("price", d.price, p.currency ?? d.currency),
		currency: p.currency ?? d.currency,
		compareAt: canonical("compareAt", d.compareAt, p.currency ?? d.currency),
		unitCost: canonical("unitCost", d.unitCost, p.currency ?? d.currency),
		productKind: d.productKind,
		taxClass: d.taxClass,
		taxStatus: d.taxStatus,
		// Blank keeps what is stored — for a digital product, whose weight and size
		// are hidden, that is exactly what should happen.
		weightGrams: d.productKind === "digital" ? "" : d.weightGrams.trim(),
		lengthMm: d.productKind === "digital" ? "" : d.lengthMm.trim(),
		widthMm: d.productKind === "digital" ? "" : d.widthMm.trim(),
		heightMm: d.productKind === "digital" ? "" : d.heightMm.trim(),
	};
}
