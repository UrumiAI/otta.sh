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

/** A currency move found under money the merchant entered. */
export interface CurrencyChange {
	/** `priced_elsewhere`: someone priced the product in another currency.
	 *  `store_default_moved`: the store currency is no longer the one the
	 *  merchant's amounts were entered against. */
	readonly kind: "priced_elsewhere" | "store_default_moved";
	/** The currency the merchant's amounts were entered in (`""`: none chosen). */
	readonly from: string;
	/** The currency now in force: the product's, or the store's. */
	readonly to: string;
}

/**
 * THE CURRENCY RULE, evaluated STATELESSLY on every merge — the background
 * re-read and the read-before-save alike — against the FRESH record:
 *  1. No money typed (no money field changed, no currency picked): the currency
 *     follows the fresh record — its stored currency if priced, else the fresh
 *     store currency (`""` while unknown). No conflict.
 *  2. Priced elsewhere in another currency, money typed: the currency becomes
 *     the stored one (it is fixed), every money field takes the fresh value
 *     (the typed amounts were in another currency — `mergeDraft` drops them),
 *     and it is a conflict that says so.
 *  3. Unpriced, money typed, NOT picked, and the fresh store currency is not
 *     the draft's (including `""` → known): the draft keeps its currency and it
 *     is a conflict until the merchant PICKS a currency — so a save made after
 *     the store currency moved can never silently price in the old default.
 *  4. Unpriced and picked: the pick stands; never a store-default conflict.
 */
export function resolveDraftCurrency(args: {
	draft: PricingDraft;
	/** A money field changed, or a currency was picked. */
	moneyTyped: boolean;
	/** The currency select was picked in the UI. */
	picked: boolean;
	fresh: ProductRecord;
	/** The fresh store currency (`""`: unknown, with no earlier known value). */
	freshStoreCurrency: string;
}): { currency: string; change: CurrencyChange | null } {
	const { draft, moneyTyped, picked, fresh, freshStoreCurrency } = args;
	if (!moneyTyped) return { currency: fresh.currency ?? freshStoreCurrency, change: null };
	if (fresh.currency !== null) {
		return fresh.currency === draft.currency
			? { currency: fresh.currency, change: null }
			: {
					currency: fresh.currency,
					change: { kind: "priced_elsewhere", from: draft.currency, to: fresh.currency },
				};
	}
	if (picked || draft.currency === freshStoreCurrency || freshStoreCurrency === "") {
		return { currency: draft.currency, change: null };
	}
	return {
		currency: draft.currency,
		change: { kind: "store_default_moved", from: draft.currency, to: freshStoreCurrency },
	};
}

/** The banner for a {@link CurrencyChange}: what changed, and what to do. */
export function currencyChangeText(change: CurrencyChange): string {
	if (change.kind === "priced_elsewhere") {
		const entered = change.from === "" ? "" : ` in ${change.from}`;
		return `This product was priced in ${change.to} by someone else — the amounts you entered${entered} were replaced with its saved ones — check every amount in ${change.to} before saving.`;
	}
	return change.from === ""
		? `Your store currency is now ${change.to} — choose this product's currency, then save.`
		: `Your store currency is now ${change.to} — this product will be priced in ${change.from} unless you choose ${change.to}. Pick the currency to confirm, then save.`;
}

/** The ONE general field-clash banner. */
export const FIELD_CONFLICT_TEXT =
	"Someone else changed this product while you were editing. The latest values are shown — check them and save again.";

/**
 * A re-read the merchant did not ask for (a CMS save, a stock movement, a
 * refusal that declined a value) — and the read-before-save — lands a FRESH
 * record under a form they may have typed into. Only the fields THEY changed
 * survive it; every other field takes the fresh value, so a save never writes a
 * stale value back over someone else's change under the fresh watermark. A
 * field they changed that ALSO changed in the store is a conflict: the store's
 * value wins FOR THAT FIELD and the merchant is told, because neither edit can
 * be assumed to be the one they want; their other edits stay. The CURRENCY
 * follows {@link resolveDraftCurrency}.
 *
 * `currencyChange` (and `fieldClash`, telling whether a field clash ALSO
 * happened, so both messages can show) is present only when the currency rule
 * raised a conflict — every other result keeps its old shape.
 */
export function mergeDraft(
	previous: ProductRecord,
	fresh: ProductRecord,
	draft: PricingDraft,
	opts: {
		/** The store currency the form was seeded with (what `previous` showed). */
		storeCurrency?: string;
		/** The FRESH store currency; defaults to `storeCurrency`. */
		freshStoreCurrency?: string;
		/** The merchant picked the currency in the UI. */
		currencyPicked?: boolean;
	} = {},
): {
	draft: PricingDraft;
	conflict: boolean;
	currencyChange?: CurrencyChange;
	fieldClash?: boolean;
} {
	const storeCurrency = opts.storeCurrency ?? DEFAULT_STORE_CURRENCY;
	const freshStoreCurrency = opts.freshStoreCurrency ?? storeCurrency;
	const picked = opts.currencyPicked === true;
	const before = draftFromRecord(previous, storeCurrency);
	const after = draftFromRecord(fresh, freshStoreCurrency);
	const changed = changedFields(before, draft);
	const mine = changed.filter((field) => field !== "currency");
	// A clash takes the store's value for THAT field; the merchant's other edits
	// survive, so a conflict on the weight does not throw away a typed price.
	const merged: Record<string, string> = { ...after };
	let fieldClash = false;
	for (const field of mine) {
		if (
			canonical(field, before[field], before.currency) !==
			canonical(field, after[field], after.currency)
		) {
			fieldClash = true;
		} else merged[field] = draft[field];
	}
	const currency = resolveDraftCurrency({
		draft,
		moneyTyped: picked || mine.some((field) => MONEY_FIELDS.has(field)),
		picked,
		fresh,
		freshStoreCurrency,
	});
	merged["currency"] = currency.currency;
	// Priced elsewhere in another currency: every amount the merchant typed was
	// entered in a currency the product no longer has, so EVERY money field takes
	// the fresh record's value — kept, a typed "9.50" would be saved as 9.500 KWD.
	if (currency.change?.kind === "priced_elsewhere") {
		for (const field of MONEY_FIELDS) merged[field] = after[field];
	}
	const result = { draft: merged as unknown as PricingDraft };
	return currency.change === null
		? { ...result, conflict: fieldClash }
		: { ...result, conflict: true, currencyChange: currency.change, fieldClash };
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
