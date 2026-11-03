/**
 * Cash on delivery's settings (ADR-0044), plain plugin kv beside the Stripe
 * keys, saved from the Cash on delivery group of the Store settings page.
 *
 *  - `settings:codEnabled` — the toggle. ONLY a stored `true` turns it on: a
 *    store that never saved it (every store before ADR-0044), a kv miss or any
 *    other value reads as OFF, so existing stores see no change.
 *  - `settings:codInstructions` — optional text shown to the buyer under the
 *    method at checkout and on the order page ("Please have the exact amount
 *    ready"). Plain text, at most {@link COD_INSTRUCTIONS_MAX} characters.
 *
 *  - `settings:codAutoCancelDays` — unpaid `awaiting_payment` orders older than
 *    this many days are cancelled by the `cod-auto-cancel` sweep leg. 0..365,
 *    default {@link DEFAULT_OFFLINE_AUTO_CANCEL_DAYS} (14); 0 turns it off.
 *  - `settings:codMaxOpenPerBuyer` / `settings:codMaxOpenPerClient` — caps on open
 *    COD orders per buyer email (default 3) and per client network (default 20 —
 *    carrier and office NAT put many honest buyers behind one address, ADR-0044
 *    §7). 0..100; 0 means no cap.
 *
 * WHERE THE TOGGLE IS ENFORCED. The domain checks it, inside
 * `createOrderFromCart`, for a FRESH placement only — so a same-key replay of an
 * order placed while COD was on still answers that order after it is switched
 * off (review finding 11). Checkout therefore always arms the gateway
 * (`resolvePaymentGateways`'s `cashOnDelivery: "always"`) and hands the domain the
 * policy read here ({@link readCodCheckoutPolicy}).
 *
 * NEVER A CARD-ONLY STORE'S PROBLEM (review finding 10). Every read a storefront
 * route makes here fails SOFT: a kv failure reads as COD off, logged once per
 * failed read, so `storefront/payment-config` and card checkout keep working.
 * The Settings page reads the raw values instead (it hides the form on a failure,
 * so a save cannot write a blank over them).
 */
import { DEFAULT_OFFLINE_AUTO_CANCEL_DAYS } from "@urumi.ai/otta-domain";
import { CashOnDeliveryGateway } from "@urumi.ai/otta-payments-cod";
import type { PluginContext } from "../types.js";

export const COD_ENABLED_KEY = "settings:codEnabled";
export const COD_INSTRUCTIONS_KEY = "settings:codInstructions";
export const COD_INSTRUCTIONS_MAX = 500;
export const COD_AUTO_CANCEL_DAYS_KEY = "settings:codAutoCancelDays";
export const COD_MAX_OPEN_PER_BUYER_KEY = "settings:codMaxOpenPerBuyer";
export const COD_MAX_OPEN_PER_CLIENT_KEY = "settings:codMaxOpenPerClient";

/** One whole-number COD setting: its key, its bounds and its default. */
export interface CodNumberSetting {
	readonly key: string;
	/** The form field's action id. */
	readonly field: string;
	readonly label: string;
	readonly min: number;
	readonly max: number;
	readonly fallback: number;
}

export const COD_AUTO_CANCEL_DAYS: CodNumberSetting = {
	key: COD_AUTO_CANCEL_DAYS_KEY,
	field: "codAutoCancelDays",
	label: "Auto-cancel unpaid orders after (days)",
	min: 0,
	max: 365,
	fallback: DEFAULT_OFFLINE_AUTO_CANCEL_DAYS,
};
export const COD_MAX_OPEN_PER_BUYER: CodNumberSetting = {
	key: COD_MAX_OPEN_PER_BUYER_KEY,
	field: "codMaxOpenPerBuyer",
	label: "Most unpaid orders per buyer email",
	min: 0,
	max: 100,
	fallback: 3,
};
export const COD_MAX_OPEN_PER_CLIENT: CodNumberSetting = {
	key: COD_MAX_OPEN_PER_CLIENT_KEY,
	field: "codMaxOpenPerClient",
	label: "Most unpaid orders per network",
	min: 0,
	max: 100,
	// ADR-0044 §7 (round 2): NAT puts many buyers behind one address.
	fallback: 20,
};
/** The three, in the order the Settings form shows them. */
export const COD_NUMBER_SETTINGS: readonly CodNumberSetting[] = [
	COD_AUTO_CANCEL_DAYS,
	COD_MAX_OPEN_PER_BUYER,
	COD_MAX_OPEN_PER_CLIENT,
];

export type CodNumberValidation = { ok: true; value: number } | { ok: false; message: string };

/** A whole number within the setting's bounds — a number, or digits as text (a
 *  form's text field). Refused, never clamped. */
export function validateCodNumber(spec: CodNumberSetting, raw: unknown): CodNumberValidation {
	const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
	const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
		return {
			ok: false,
			message:
				`${spec.label} must be a whole number from ${String(spec.min)} to ${String(spec.max)}` +
				` — got ${text === "" ? "nothing" : `"${text}"`}.`,
		};
	}
	return { ok: true, value };
}

/** The stored value, or the default when none is stored or it is unusable. A kv
 *  failure propagates (the Settings page's read); see {@link readCodNumberSoft}. */
export async function readCodNumber(ctx: PluginContext, spec: CodNumberSetting): Promise<number> {
	const stored = await ctx.kv.get<unknown>(spec.key);
	if (stored === null || stored === undefined) return spec.fallback;
	const checked = validateCodNumber(spec, stored);
	return checked.ok ? checked.value : spec.fallback;
}

/** Whether the merchant turned cash on delivery on. A kv failure propagates. */
export async function readCodEnabled(ctx: PluginContext): Promise<boolean> {
	return (await ctx.kv.get<unknown>(COD_ENABLED_KEY)) === true;
}

/** The buyer-facing instructions, trimmed, or `null` when none were saved. */
export async function readCodInstructions(ctx: PluginContext): Promise<string | null> {
	const stored = await ctx.kv.get<unknown>(COD_INSTRUCTIONS_KEY);
	if (typeof stored !== "string") return null;
	const trimmed = stored.trim().slice(0, COD_INSTRUCTIONS_MAX);
	return trimmed.length === 0 ? null : trimmed;
}

/** What checkout hands the domain about cash on delivery right now (ADR-0044). */
export interface OfflinePolicy {
	enabled: boolean;
	/** 0 ⇒ no cap. */
	maxOpenPerBuyer: number;
	/** 0 ⇒ no cap. */
	maxOpenPerClient: number;
}

/** COD off: what any failed read means. */
export const OFFLINE_POLICY_OFF: OfflinePolicy = {
	enabled: false,
	maxOpenPerBuyer: COD_MAX_OPEN_PER_BUYER.fallback,
	maxOpenPerClient: COD_MAX_OPEN_PER_CLIENT.fallback,
};

/** Log a failed COD read, once per failure, naming what it falls back to. */
export function logCodReadFailure(where: string, err: unknown): void {
	console.error(
		`[otta] ${where}: the cash-on-delivery settings could not be read; treating cash on delivery as off:`,
		err instanceof Error ? err.message : String(err),
	);
}

/**
 * The toggle and both caps, for a COD placement — FAIL-SOFT: a kv failure is COD
 * off (logged), never a thrown checkout. Three kv reads, made only when the buyer
 * chose cash on delivery.
 */
export async function readCodCheckoutPolicy(ctx: PluginContext): Promise<OfflinePolicy> {
	try {
		const [enabled, maxOpenPerBuyer, maxOpenPerClient] = await Promise.all([
			readCodEnabled(ctx),
			readCodNumber(ctx, COD_MAX_OPEN_PER_BUYER),
			readCodNumber(ctx, COD_MAX_OPEN_PER_CLIENT),
		]);
		return { enabled, maxOpenPerBuyer, maxOpenPerClient };
	} catch (err) {
		logCodReadFailure("checkout", err);
		return OFFLINE_POLICY_OFF;
	}
}

/** The auto-cancel window in days (0 ⇒ off) — FAIL-SOFT to off: a sweep that
 *  cannot read the merchant's window must not cancel by a window they never set. */
export async function readCodAutoCancelDays(ctx: PluginContext): Promise<number> {
	try {
		return await readCodNumber(ctx, COD_AUTO_CANCEL_DAYS);
	} catch (err) {
		console.error(
			"[otta] the cash-on-delivery auto-cancel window could not be read; nothing is auto-cancelled this run:",
			err instanceof Error ? err.message : String(err),
		);
		return 0;
	}
}

/**
 * The gateway, when the merchant enabled it (or `always`); else `undefined`.
 * FAIL-SOFT: a toggle that cannot be read is COD off (logged), so a kv failure on
 * the COD keys never fails the card gateway resolved beside it.
 */
export async function codGatewayFromCtx(
	ctx: PluginContext,
	always = false,
): Promise<CashOnDeliveryGateway | undefined> {
	if (always) return new CashOnDeliveryGateway();
	try {
		if (await readCodEnabled(ctx)) return new CashOnDeliveryGateway();
	} catch (err) {
		logCodReadFailure("payment gateways", err);
	}
	return undefined;
}
