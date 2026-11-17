/**
 * The admin SETTINGS operations: the decision half of each Settings write, with
 * no form parsing and no notice.
 *
 * WHY THEY ARE HERE. These rules used to live inline in the Settings screen's
 * handler (`settings-form.ts`): the store currency switch asks first when
 * products are priced in the old currency, and its confirm is re-checked
 * against the currency it was asked about (`from`); the cash-on-delivery save
 * asks first when a shorter auto-cancel window would cancel open unpaid orders,
 * and its confirm is re-checked against the window it was asked about; the
 * operational values are range-checked by field; the display name is bounded;
 * and a payment secret is shape-checked, written write-only to its kv key (the
 * host encrypts it at rest, ADR-0037), and its save generation bumped. A second
 * caller (the MCP tools) calling the stores directly would have to restate all
 * of them. So each write is one function here, and both callers go through it:
 * the page parses its form, calls the operation, and turns the outcome into a
 * notice; an MCP route validates its input, calls the operation, and turns the
 * outcome into JSON. Moved verbatim — no rule changed on the way.
 *
 * WHAT STAYS ON THE PAGE. Form parsing (the toggle's "didn't come through"
 * refusal included), the confirm buttons and what they carry back, and every
 * word of notice copy. The two exceptions are sentences an outcome carries
 * because the operation decides them: a `needs_confirmation`'s `message` (the
 * page's "N products are priced in …" / "Lowering the window to …" sentence,
 * also the confirm dialog's text) and a refusal's rule sentence (as
 * `validateCodNumber` already worded it).
 *
 * SECRETS ARE NEVER RETURNED. No outcome, and no field of
 * {@link readSettingsSummary}, carries a secret value or any part of one — only
 * whether one is stored.
 *
 * ONE NEW PIECE, used only by MCP: {@link readSettingsSummary}. And
 * {@link saveCashOnDelivery} keeps the stored instructions when `instructions`
 * is left out (the page always sends them, so its behaviour is unchanged).
 */
import {
	effectiveStoreCurrency,
	isSupportedCurrency,
	MAX_HOLD_TTL_MINUTES,
} from "@urumi.ai/otta-domain";
import type { ProductCommerceStore } from "@urumi.ai/otta-domain";
import { createInProcessCommerceStores } from "../../commerce/in-process-commerce-stores.js";
import { STORE_DISPLAY_NAME_KEY } from "../../email/email-render-context.js";
import { encryptionKeyStatus } from "../../encryption-key-status.js";
import {
	checkOpaqueToken,
	checkStripeSecretKey,
	checkStripeWebhookSecret,
	type SecretShapeCheck,
} from "../../payment-secret-shapes.js";
import {
	readSecret,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
} from "../../payment-secrets.js";
import {
	COD_AUTO_CANCEL_DAYS,
	COD_AUTO_CANCEL_DAYS_KEY,
	COD_ENABLED_KEY,
	COD_INSTRUCTIONS_KEY,
	COD_INSTRUCTIONS_MAX,
	COD_MAX_OPEN_PER_BUYER,
	COD_MAX_OPEN_PER_CLIENT,
	COD_MAX_UNITS_PER_ORDER,
	COD_NUMBER_SETTINGS,
	type CodNumberField,
	readCodEnabled,
	readCodInstructions,
	readCodNumber,
	validateCodNumber,
} from "../../payments/cash-on-delivery.js";
import { refreshStripeAccountCountry } from "../../payments/stripe-account-country.js";
import type { PluginContext } from "../../types.js";
import { clearStripeWebhookLastVerified } from "../../webhooks/stripe-webhook-last-verified.js";
import { MAX_LOW_STOCK_THRESHOLD } from "../in-process-reporting-settings-client.js";
import type {
	OperationalSettingsWire,
	ReportingSettingsSurface,
} from "../reporting-settings-surface.js";

/** A save that would do something the caller has not agreed to: nothing was
 *  changed. `message` states what (the sentence the console's confirm step
 *  shows); `affected` is how many products or orders it touches. Saving it
 *  anyway is the same call with `confirm: { from }`. */
export type NeedsConfirmation = { kind: "needs_confirmation"; message: string; affected: number };

// -- save generations -----------------------------------------------------------

/** Current save generation for a token key, defaulting to 0 when never saved.
 *  FAIL-SOFT (INC-C3): a kv read that REJECTS degrades to 0 rather than taking
 *  the whole render down — the generation only forces a field to remount blank,
 *  so getting it wrong costs a stale-looking input, while throwing would lock an
 *  operator out of the one screen they would use to re-provision. */
export async function readSaveGen(ctx: PluginContext, key: string): Promise<number> {
	try {
		return (await ctx.kv.get<number>(key)) ?? 0;
	} catch {
		return 0;
	}
}

/** Bump a token's save generation. Call ONLY on an actual (non-empty) persist —
 *  never on a blank submit, which already leaves the field's stated content
 *  correct (still empty), so there is nothing to force a remount for. */
async function bumpSaveGen(ctx: PluginContext, key: string): Promise<void> {
	await ctx.kv.set(key, (await readSaveGen(ctx, key)) + 1);
}

// -- store display name ---------------------------------------------------------

export const DISPLAY_NAME_MAX = 200;

/** Save the store display name, trimmed: 1–{@link DISPLAY_NAME_MAX} characters. */
export async function saveStoreDisplayName(
	ctx: PluginContext,
	name: string,
): Promise<{ kind: "saved"; name: string } | { kind: "invalid"; max: number }> {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX) {
		return { kind: "invalid", max: DISPLAY_NAME_MAX };
	}
	await ctx.kv.set(STORE_DISPLAY_NAME_KEY, trimmed);
	return { kind: "saved", name: trimmed };
}

// -- store currency -------------------------------------------------------------

/** Live (not deleted) products priced in `code`, counted by walking the store's
 *  product list a page at a time — the store directly, not the admin client,
 *  whose pages each also run a full `countProducts`. Throws when the list cannot
 *  be read through. */
async function countProductsPricedIn(
	products: Pick<ProductCommerceStore, "listProducts">,
	code: string,
): Promise<number> {
	let count = 0;
	let page = await products.listProducts({}, { limit: 100 });
	for (;;) {
		count += page.products.filter((p) => p.price?.currency === code).length;
		if (page.nextCursor === null) return count;
		page = await products.listProducts({}, { cursor: page.nextCursor, limit: 100 });
	}
}

/** "2 products are priced in USD." — a currency switch's confirm sentence. */
export function pricedProductsText(ask: { count: number; from: string }): string {
	return ask.count === 1
		? `1 product is priced in ${ask.from}.`
		: `${String(ask.count)} products are priced in ${ask.from}.`;
}

export interface StoreCurrencyInput {
	/** The ISO 4217 code new carts are to be created in; trimmed. */
	currency: string;
	/** Present ⇒ the caller confirms a switch it was asked about: `from` is the
	 *  currency the count was made against. A store whose currency has moved
	 *  since is not switched (`stale`). */
	confirm?: { from: unknown };
	/** Absent ⇒ one is made from the time. */
	idempotencyKey?: string;
}

export type StoreCurrencyOutcome =
	| { kind: "saved"; currency: string }
	/** Already the store currency: nothing written. `settings` is the read made. */
	| { kind: "unchanged"; currency: string; settings: OperationalSettingsWire }
	/** Not a supported code (or the store refused it as invalid). */
	| { kind: "unsupported"; currency: string }
	/** The settings could not be read, so nothing was changed. */
	| { kind: "settings_unreadable" }
	/** A confirm whose `from` is no longer the store currency. */
	| { kind: "stale" }
	/** The products priced in `from` could not be counted, so nothing was changed. */
	| { kind: "count_failed"; from: string }
	/** Products are priced in `from`; switching strands them. */
	| (NeedsConfirmation & { from: string; to: string; settings: OperationalSettingsWire })
	/** Another save won the store's compare-and-set: not applied. */
	| { kind: "superseded"; message: string }
	/** The store could not say whether it applied. */
	| { kind: "unconfirmed" };

/**
 * Set the currency NEW carts are created in (one field of the settings
 * document: the hold time, threshold and tax block are untouched).
 *
 * #447: a switch AWAY from the currency products are priced in is
 * `needs_confirmation` (products keep their currency, so those become
 * unbuyable in new carts); the same call with `confirm: { from }` saves.
 */
export async function saveStoreCurrency(
	ctx: PluginContext,
	client: ReportingSettingsSurface,
	input: StoreCurrencyInput,
): Promise<StoreCurrencyOutcome> {
	const code = input.currency.trim();
	// Saving UNCHANGED writes nothing — checked FIRST, so a stored code the table
	// (or checkout) no longer accepts can still be "saved" as is. A store that
	// never saved one stays never-saved (USD by the upgrade rule, not by a stored
	// "USD"). A failed read cannot tell, and cannot say which products the switch
	// would strand (#447), so it saves nothing — refused below, after an
	// unsupported code is named.
	const current = await client.getSettings().catch(() => undefined);
	if (current !== undefined && effectiveStoreCurrency(current) === code) {
		return { kind: "unchanged", currency: code, settings: current };
	}
	if (!isSupportedCurrency(code)) return { kind: "unsupported", currency: code };
	if (current === undefined) return { kind: "settings_unreadable" };
	if (input.confirm !== undefined) {
		// The count the operator confirmed was for `from`. A store whose
		// currency moved since is not switched on it.
		if (effectiveStoreCurrency(current) !== input.confirm.from) return { kind: "stale" };
	} else {
		const from = effectiveStoreCurrency(current);
		let count: number;
		try {
			count = await countProductsPricedIn(createInProcessCommerceStores(ctx).productCommerce, from);
		} catch (err) {
			console.error("[otta] admin settings priced-product count failed:", err);
			return { kind: "count_failed", from };
		}
		if (count > 0) {
			return {
				kind: "needs_confirmation",
				message: pricedProductsText({ count, from }),
				affected: count,
				from,
				to: code,
				settings: current,
			};
		}
	}
	const key =
		input.idempotencyKey !== undefined && input.idempotencyKey.length > 0
			? input.idempotencyKey
			: `settings-currency-${Date.now()}`;
	const result = await client.updateSettings({ currency: code }, { idempotencyKey: key });
	if (!result.ok) {
		if (result.reason === "superseded") return { kind: "superseded", message: result.message };
		if (result.reason === "validation") return { kind: "unsupported", currency: code };
		// UNAVAILABLE: nothing is known about whether it applied.
		return { kind: "unconfirmed" };
	}
	return { kind: "saved", currency: code };
}

// -- cash on delivery (ADR-0044) ------------------------------------------------

/** The affected-orders count stops here, and reads "100+" from it on: the
 *  listing asks for one more, but the host clamps a query page at 100, so 100
 *  back may mean more. */
export const COD_LOWERING_COUNT_CAP = 100;

/**
 * How many open `awaiting_payment` orders a window of `days` puts past due — the
 * sweep's own listing (`listAwaitingPaymentBefore`, the `["state", "createdAt"]`
 * index), asked for one past {@link COD_LOWERING_COUNT_CAP} (a host may clamp the
 * page to the cap itself). Throws when the list cannot be read.
 */
async function countCodOrdersPastWindow(ctx: PluginContext, days: number): Promise<number> {
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
	const due = await createInProcessCommerceStores(ctx).orderStore.listAwaitingPaymentBefore(
		cutoff,
		COD_LOWERING_COUNT_CAP + 1,
	);
	return due.length;
}

/** "Lowering the window to 7 days cancels 2 unpaid …" — the shorter window's
 *  confirm sentence. */
export function codLoweringText(ask: { days: number; affected: number }): string {
	const count =
		ask.affected >= COD_LOWERING_COUNT_CAP
			? `${String(COD_LOWERING_COUNT_CAP)}+ unpaid cash-on-delivery orders`
			: ask.affected === 1
				? "1 unpaid cash-on-delivery order"
				: `${String(ask.affected)} unpaid cash-on-delivery orders`;
	const days = ask.days === 1 ? "1 day" : `${String(ask.days)} days`;
	return `Lowering the window to ${days} cancels ${count} on the next sweep (their stock goes back on sale and the buyers are emailed). Save anyway?`;
}

export interface CashOnDeliveryInput {
	/** Whether checkout offers cash on delivery. */
	enabled: boolean;
	/** The buyer instructions, trimmed; blank clears them. Left out ⇒ the stored
	 *  instructions are kept (the console always sends them). */
	instructions?: string;
	/** The auto-cancel window and the caps, by form field (`COD_NUMBER_SETTINGS`:
	 *  `codAutoCancelDays`, …) — a whole number, or digits as text. One left out
	 *  is kept as stored; one present and unusable refuses the WHOLE save. */
	numbers?: Readonly<Partial<Record<CodNumberField, unknown>>>;
	/** Present ⇒ the caller confirms a shorter window it was asked about: `from`
	 *  is the window the count was made against. A window that has moved since
	 *  is not overwritten (`stale`). */
	confirm?: { from: unknown };
}

export type CashOnDeliveryOutcome =
	| { kind: "saved"; enabled: boolean }
	/** A rule broken; `message` states it. Nothing was written. */
	| { kind: "invalid"; message: string }
	/** The stored window could not be read, so nothing was changed. */
	| { kind: "window_unreadable" }
	/** A confirm whose `from` is no longer the stored window. */
	| { kind: "stale" }
	/** The orders the new window would cancel could not be counted. */
	| { kind: "count_failed" }
	/** A shorter window (`days`, from `from`) cancels `affected` open unpaid
	 *  orders on the next sweep — `COD_LOWERING_COUNT_CAP` or more reads "100+". */
	| (NeedsConfirmation & { days: number; from: number });

/**
 * Save cash on delivery's toggle, instructions and numbers — all or nothing.
 *
 * B flag 4: LOWERING the auto-cancel window (to a value above 0) cancels the
 * open unpaid orders now older than it on the next sweep, so a save that would
 * do that to any is `needs_confirmation`; the same call with `confirm: { from }`
 * saves.
 */
export async function saveCashOnDelivery(
	ctx: PluginContext,
	input: CashOnDeliveryInput,
): Promise<CashOnDeliveryOutcome> {
	const instructions = input.instructions?.trim();
	// The window and the caps: whole numbers within bounds. One that is absent
	// is kept as stored; one present and unusable refuses the WHOLE save, so
	// nothing is half-written.
	const numbers: { key: string; value: number }[] = [];
	let numberRefusal: string | undefined;
	for (const spec of COD_NUMBER_SETTINGS) {
		const raw = input.numbers?.[spec.field];
		if (raw === undefined) continue;
		const checked = validateCodNumber(spec, raw);
		if (!checked.ok) {
			numberRefusal ??= checked.message;
			continue;
		}
		numbers.push({ key: spec.key, value: checked.value });
	}
	const refusal =
		instructions !== undefined && instructions.length > COD_INSTRUCTIONS_MAX
			? `Instructions must be at most ${String(COD_INSTRUCTIONS_MAX)} characters.`
			: numberRefusal;
	if (refusal !== undefined) return { kind: "invalid", message: refusal };
	const newWindow = numbers.find((n) => n.key === COD_AUTO_CANCEL_DAYS_KEY)?.value;
	if (newWindow !== undefined) {
		let stored: number;
		try {
			stored = await readCodNumber(ctx, COD_AUTO_CANCEL_DAYS);
		} catch (err) {
			console.error("[otta] admin settings: the COD auto-cancel window read failed:", err);
			return { kind: "window_unreadable" };
		}
		if (input.confirm !== undefined) {
			// The count the operator confirmed was against `from`. A window that
			// moved since is not overwritten on it.
			if (stored !== input.confirm.from) return { kind: "stale" };
		} else if (newWindow > 0 && newWindow < stored) {
			let affected: number;
			try {
				affected = await countCodOrdersPastWindow(ctx, newWindow);
			} catch (err) {
				console.error("[otta] admin settings: the COD auto-cancel count failed:", err);
				return { kind: "count_failed" };
			}
			if (affected > 0) {
				return {
					kind: "needs_confirmation",
					message: codLoweringText({ days: newWindow, affected }),
					affected,
					days: newWindow,
					from: stored,
				};
			}
		}
	}
	for (const { key, value } of numbers) await ctx.kv.set(key, value);
	if (instructions !== undefined) await ctx.kv.set(COD_INSTRUCTIONS_KEY, instructions);
	// The toggle last: switching COD on is the write that makes the rest live.
	await ctx.kv.set(COD_ENABLED_KEY, input.enabled);
	return { kind: "saved", enabled: input.enabled };
}

// -- operational settings: hold time, low-stock threshold, hold timer -----------

/** Non-money integer fields (minutes, thresholds) route through `text_input`
 *  with ONE parsing discipline (F-6): digits only, no sign, no decimal point.
 *  Accepts a raw `number` too. */
const DIGITS_ONLY = /^\d+$/;

/** Each operational field: its name as the operator reads it, its bounds, and
 *  the rule a refusal states. The bounds are the domain's own
 *  (`MAX_HOLD_TTL_MINUTES`) and the settings client's (`MAX_LOW_STOCK_THRESHOLD`),
 *  checked here so the refusal can name the field and cover every field at once. */
export const OPERATIONAL_FIELDS = [
	{
		id: "holdTtlMinutes",
		name: "Cart hold time",
		min: 1,
		max: MAX_HOLD_TTL_MINUTES,
		rule: `must be a whole number of minutes from 1 to ${String(MAX_HOLD_TTL_MINUTES)}.`,
	},
	{
		id: "lowStockThreshold",
		name: "Low-stock threshold",
		min: 0,
		max: MAX_LOW_STOCK_THRESHOLD,
		rule: `must be a whole number from 0 to ${String(MAX_LOW_STOCK_THRESHOLD)}.`,
	},
] as const satisfies ReadonlyArray<{
	id: keyof OperationalSettingsWire;
	name: string;
	min: number;
	max: number;
	rule: string;
}>;

/** An operational value refused: its field, and the rule, named for the operator. */
export interface OperationalProblem {
	field: (typeof OPERATIONAL_FIELDS)[number]["id"];
	message: string;
}

/** The operational values as a form shows them, as typed. */
export interface OperationalTypedValues {
	holdTtlMinutes?: string;
	lowStockThreshold?: string;
	showHoldTimer?: boolean;
}

/**
 * U-8: check every PRESENT operational value. A field absent is left alone
 * (absent is not empty — the INC-C5 rule); a field present but blank, signed,
 * fractional, non-numeric or out of range is a PROBLEM, named. The patch is
 * only meant to be sent when there are no problems. `typed` is each present
 * value as it came, for a form to put back.
 */
export function checkOperationalValues(values: Readonly<Record<string, unknown>>): {
	patch: Partial<OperationalSettingsWire>;
	typed: OperationalTypedValues;
	problems: OperationalProblem[];
} {
	const patch: Partial<OperationalSettingsWire> = {};
	const typed: OperationalTypedValues = {};
	const problems: OperationalProblem[] = [];
	for (const spec of OPERATIONAL_FIELDS) {
		const raw = values[spec.id];
		if (typeof raw !== "string" && typeof raw !== "number") continue;
		const text = String(raw).trim();
		typed[spec.id] = typeof raw === "string" ? raw : text;
		const value = DIGITS_ONLY.test(text) ? Number(text) : Number.NaN;
		if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
			problems.push({ field: spec.id, message: `${spec.name} ${spec.rule}` });
			continue;
		}
		patch[spec.id] = value;
	}
	// A toggle submits a boolean (its `initial_value` is always set, so the host
	// sends it on every submit); anything else is absent — left alone.
	if (typeof values.showHoldTimer === "boolean") {
		patch.showHoldTimer = values.showHoldTimer;
		typed.showHoldTimer = values.showHoldTimer;
	}
	return { patch, typed, problems };
}

export type OperationalSettingsOutcome =
	/** Saved; `settings` is what is now in force. */
	| { kind: "saved"; settings: OperationalSettingsWire }
	/** Values out of range (every one named); nothing was saved. */
	| { kind: "invalid"; problems: OperationalProblem[] }
	/** The store refused the patch; `message` is the store's, naming fields by id. */
	| { kind: "rejected"; message: string }
	/** Another save won the store's compare-and-set: not applied. */
	| { kind: "superseded"; message: string }
	/** The store could not say whether it applied. */
	| { kind: "unconfirmed" };

/**
 * Save the hold time, low-stock threshold and hold-timer switch — ALL OR
 * NOTHING: every present value is checked first, and one out of range refuses
 * the whole save. A value left out keeps what is stored.
 */
export async function saveOperationalSettings(
	client: ReportingSettingsSurface,
	values: Readonly<Record<string, unknown>>,
	opts: { idempotencyKey?: string } = {},
): Promise<OperationalSettingsOutcome> {
	const checked = checkOperationalValues(values);
	if (checked.problems.length > 0) return { kind: "invalid", problems: checked.problems };
	const key =
		opts.idempotencyKey !== undefined && opts.idempotencyKey.length > 0
			? opts.idempotencyKey
			: `settings-${Date.now()}`;
	const result = await client.updateSettings(checked.patch, { idempotencyKey: key });
	if (!result.ok) {
		// WHY THE SAVE FAILED, from the STRUCTURAL field first. `reason` is stated
		// by every tier that can say why; `status` is the HTTP tier's legacy
		// fallback and is read ONLY when `reason` is absent (INC-B10a). A lost
		// compare-and-set cannot be won by re-submitting under the same key.
		const superseded =
			result.reason === "superseded" || (result.reason === undefined && result.status === 409);
		if (superseded) return { kind: "superseded", message: result.message };
		// UNAVAILABLE: whether it applied is unknown — never claim "not saved".
		if (result.reason === "unavailable") return { kind: "unconfirmed" };
		return { kind: "rejected", message: result.message };
	}
	return { kind: "saved", settings: result.settings };
}

// -- payment secrets (write-only; encrypted at rest by the host, ADR-0037) ------

/** A payment secret's storage: its write-only kv key (declared `secret`, so
 *  EmDash encrypts it), its save generation's key, and the shape check (trim,
 *  then the shape the provider issues; the trimmed value is what is stored). */
export interface PaymentSecretStorage {
	kvKey: string;
	genKey: string;
	check: (raw: string) => SecretShapeCheck;
}

/** The payment secrets, by field id. Each secret has its own save generation,
 *  so saving one never blanks another's untouched field. */
export const PAYMENT_SECRET_STORAGE = {
	stripeSecretKey: {
		kvKey: STRIPE_SECRET_KEY_KEY,
		genKey: "settings:stripeSecretKeyGen",
		check: checkStripeSecretKey,
	},
	stripeWebhookSecret: {
		kvKey: STRIPE_WEBHOOK_SECRET_KEY,
		genKey: "settings:stripeWebhookSecretGen",
		check: checkStripeWebhookSecret,
	},
	webhookEdgeToken: {
		kvKey: WEBHOOK_EDGE_TOKEN_KEY,
		genKey: "settings:otta-wh-tokenGen",
		check: checkOpaqueToken,
	},
} as const satisfies Record<string, PaymentSecretStorage>;

export type PaymentSecretField = keyof typeof PAYMENT_SECRET_STORAGE;

function paymentSecretStorage(field: string): PaymentSecretStorage | undefined {
	return Object.hasOwn(PAYMENT_SECRET_STORAGE, field)
		? PAYMENT_SECRET_STORAGE[field as PaymentSecretField]
		: undefined;
}

/** #531: is `value` anything but what is stored under `key`? Unset, invalid and
 *  unreadable all count as different. */
async function storedSecretDiffers(
	ctx: PluginContext,
	key: string,
	value: string,
): Promise<boolean> {
	const before = await readSecret(ctx, key);
	return before.state !== "set" || before.value !== value;
}

/** How long the save waits on Stripe for the account's country. */
const STRIPE_ACCOUNT_READ_ON_SAVE_MS = 5_000;

export type SetPaymentSecretOutcome =
	| { kind: "saved" }
	/** Blank (or whitespace-only): nothing written; a stored secret is kept. */
	| { kind: "blank" }
	| { kind: "unknown_field" }
	/** Not the shape the provider issues; `problem` names the shape, never the
	 *  value. The secret already stored stays. */
	| { kind: "invalid"; problem: string }
	/** The host refused the write and has no usable `EMDASH_ENCRYPTION_KEY`, so
	 *  it could not be stored encrypted. Nothing was stored. */
	| { kind: "encryption_unavailable" }
	/** The host refused the write although an encryption key is present.
	 *  Nothing was stored. */
	| { kind: "write_failed" };

/**
 * Store a payment secret, write-only. Persists ONLY a non-blank value (a blank
 * keeps what is stored), bumps that secret's save generation, and never returns
 * the value. A different webhook signing secret starts its "last verified" time
 * over (#531); a new Stripe secret key has its account's country read now
 * (issue #382).
 */
export async function setPaymentSecret(
	ctx: PluginContext,
	field: string,
	value: string,
): Promise<SetPaymentSecretOutcome> {
	const spec = paymentSecretStorage(field);
	if (spec === undefined) return { kind: "unknown_field" };
	// U-8: TRIMMED, so a key copied with a trailing newline is stored as the key
	// — and a whitespace-only value is the blank it looks like.
	if (value.trim() === "") return { kind: "blank" };
	const checked = spec.check(value);
	if (!checked.ok) return { kind: "invalid", problem: checked.problem };
	// #531: a DIFFERENT webhook signing secret (possibly a wrong one) must not
	// inherit the old secret's "last verified" time. Read before the write;
	// anything but the same stored value counts as a change.
	const webhookSecretChanged =
		spec.kvKey === STRIPE_WEBHOOK_SECRET_KEY &&
		(await storedSecretDiffers(ctx, STRIPE_WEBHOOK_SECRET_KEY, checked.value));
	// ADR-0037: the host encrypts this write, and refuses it BEFORE storing
	// anything when it has no usable EMDASH_ENCRYPTION_KEY. The error itself is
	// never passed on (it may carry nothing useful, and must carry no value).
	try {
		await ctx.kv.set(spec.kvKey, checked.value);
	} catch {
		return encryptionKeyStatus() === "present"
			? { kind: "write_failed" }
			: { kind: "encryption_unavailable" };
	}
	await bumpSaveGen(ctx, spec.genKey);
	if (webhookSecretChanged) await clearStripeWebhookLastVerified(ctx);
	// Issue #382: a new Stripe key may be another account — read its country
	// NOW, so the answer is cached before the first checkout needs it. Never
	// throws; a failure is recorded as unknown and asked again later.
	if (spec.kvKey === STRIPE_SECRET_KEY_KEY) {
		await refreshStripeAccountCountry(ctx, { timeoutMs: STRIPE_ACCOUNT_READ_ON_SAVE_MS });
	}
	return { kind: "saved" };
}

/**
 * Remove a stored payment secret on purpose. Nothing stored is `not_stored`
 * (never a claimed removal); a stored value this site cannot read (ADR-0037)
 * IS stored, and removing it is the way out.
 */
export async function clearPaymentSecret(
	ctx: PluginContext,
	field: string,
): Promise<{ kind: "cleared" } | { kind: "not_stored" } | { kind: "unknown_field" }> {
	const spec = paymentSecretStorage(field);
	if (spec === undefined) return { kind: "unknown_field" };
	if ((await readSecret(ctx, spec.kvKey)).state === "unset") return { kind: "not_stored" };
	await ctx.kv.delete(spec.kvKey);
	return { kind: "cleared" };
}

// -- the summary (MCP's `settings_get`) -----------------------------------------

/** Whether a payment secret is stored — never any part of it. `unreadable`: a
 *  value is stored but this site cannot read it (ADR-0037: a ciphertext it
 *  cannot decrypt, or a kv failure); `invalid`: a value is stored but is not
 *  the shape Otta saves. Neither is used, so checkout treats both as not set. */
export type PaymentSecretState = "set" | "not_set" | "unreadable" | "invalid";

/** Every cash-on-delivery setting as now in force: each number is the stored
 *  value, or its default when none is stored (what checkout applies);
 *  `instructions` is `null` when none are saved. */
export interface CashOnDeliverySummary {
	enabled: boolean;
	autoCancelDays: number;
	maxOpenPerBuyer: number;
	maxOpenPerClient: number;
	maxUnitsPerOrder: number;
	instructions: string | null;
}

/** Read {@link CashOnDeliverySummary}. A kv failure throws. */
export async function readCashOnDeliverySummary(
	ctx: PluginContext,
): Promise<CashOnDeliverySummary> {
	const [
		enabled,
		autoCancelDays,
		maxOpenPerBuyer,
		maxOpenPerClient,
		maxUnitsPerOrder,
		instructions,
	] = await Promise.all([
		readCodEnabled(ctx),
		readCodNumber(ctx, COD_AUTO_CANCEL_DAYS),
		readCodNumber(ctx, COD_MAX_OPEN_PER_BUYER),
		readCodNumber(ctx, COD_MAX_OPEN_PER_CLIENT),
		readCodNumber(ctx, COD_MAX_UNITS_PER_ORDER),
		readCodInstructions(ctx),
	]);
	return {
		enabled,
		autoCancelDays,
		maxOpenPerBuyer,
		maxOpenPerClient,
		maxUnitsPerOrder,
		instructions,
	};
}

export interface SettingsSummary {
	storeDisplayName: string;
	/** The currency new carts are created in (USD when never saved). */
	currency: string;
	operational: OperationalSettingsWire;
	cashOnDelivery: CashOnDeliverySummary;
	paymentSecrets: Record<PaymentSecretField, PaymentSecretState>;
}

/**
 * Everything the Settings screen states, as data. The payment secrets are
 * reported as {@link PaymentSecretState} only: their values stop inside this
 * function. A failed read of the settings, the display name or cash on
 * delivery throws.
 */
export async function readSettingsSummary(
	ctx: PluginContext,
	client: ReportingSettingsSurface,
): Promise<SettingsSummary> {
	const fields = Object.keys(PAYMENT_SECRET_STORAGE) as PaymentSecretField[];
	const [operational, displayName, cashOnDelivery, secrets] = await Promise.all([
		client.getSettings(),
		ctx.kv.get<unknown>(STORE_DISPLAY_NAME_KEY),
		readCashOnDeliverySummary(ctx),
		Promise.all(
			fields.map(async (field) => {
				const read = await readSecret(ctx, PAYMENT_SECRET_STORAGE[field].kvKey);
				const state: PaymentSecretState = read.state === "unset" ? "not_set" : read.state;
				return [field, state] as const;
			}),
		),
	]);
	return {
		storeDisplayName: typeof displayName === "string" ? displayName : "",
		currency: effectiveStoreCurrency(operational),
		operational,
		cashOnDelivery,
		paymentSecrets: Object.fromEntries(secrets) as Record<PaymentSecretField, PaymentSecretState>,
	};
}
