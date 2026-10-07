/**
 * The checkout DRAFT — what the buyer typed into the review form, kept across a
 * refused `POST /checkout/place` (QA U-1).
 *
 * WHY A COOKIE. Every refusal 303s back to `/checkout` (POST-redirect-GET: a
 * reload must never re-post an order), and that redirect may carry no personal
 * data — an email and a home address in a query string end up in browser
 * history, in every subresource's Referer and in the CDN's access logs (the
 * exposure ADR-0012 §6 argues against for the client secret). So the redirect
 * carries only the error token and the non-personal selection, as before, and
 * the typed values travel in this first-party cookie instead:
 *
 *  - `httpOnly` — no script reads it; `Secure`; `SameSite=Strict` — it rides
 *    only this site's own navigations, which is the only place it is needed;
 *  - `Path=/checkout` — sent to the review and the place endpoint, nowhere else;
 *  - 15 minutes, a hold's length — it dies with the checkout it belongs to, is
 *    cleared on a successful place and by "Start a new cart";
 *  - WHITELISTED fields only, each bounded: the buyer's own email, address,
 *    phone and (for a coupon refused at place) the code they typed. Never the
 *    idempotency key, never a client secret, never anything else the form echoes.
 *
 * It holds the field each error identifies as well (`errors`), and the token
 * those errors belong to (`error`): the review marks a field only when the URL
 * carries that same token, so a stale draft never puts an old error on a field.
 */
import { BUYER_REF_MAX, ORDER_ADDRESS_MAX_LENGTHS } from "@otta-sh/plugin";
import type { CookieDeleter, CookieReader, CookieSetOptions } from "./checkout-cookie.js";

export const CHECKOUT_DRAFT_COOKIE = "otta_checkout_draft";
export const CHECKOUT_DRAFT_MAX_AGE_SECONDS = 900;
const DRAFT_PATH = "/checkout";

/** The address fields, as the place form names them (and `ORDER_ADDRESS_MAX_LENGTHS` bounds them). */
export const DRAFT_ADDRESS_FIELDS = [
	"name",
	"line1",
	"line2",
	"city",
	"postalCode",
	"country",
	"region",
	"phone",
] as const;
export type DraftAddressField = (typeof DRAFT_ADDRESS_FIELDS)[number];
export type DraftField = "email" | DraftAddressField;
export const DRAFT_FIELDS: readonly DraftField[] = ["email", ...DRAFT_ADDRESS_FIELDS];

/** Why a field was refused. */
export type DraftFieldError = "missing" | "too_long" | "invalid";
const FIELD_ERRORS: ReadonlySet<string> = new Set(["missing", "too_long", "invalid"]);

export interface CheckoutDraft {
	values: Partial<Record<DraftField, string>>;
	errors: Partial<Record<DraftField, DraftFieldError>>;
	/** The `?error=` token `errors` belong to. */
	error?: string;
	/** A coupon code refused AT PLACE — the redirect drops it from the URL. */
	coupon?: string;
}

/** A value longer than this was not typed into this form (each field's own bound
 *  plus room for a too-long value the buyer must be shown to shorten it). */
function maxStoredLength(field: DraftField): number {
	return 2 * (field === "email" ? BUYER_REF_MAX : ORDER_ADDRESS_MAX_LENGTHS[field]);
}

const TOKEN_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const COUPON_MAX = 200;
/** Comfortably under the ~4 KB a browser keeps per cookie. */
const COOKIE_BUDGET = 3500;

/** Only the whitelisted, string-valued, bounded fields of `raw`. */
function cleanValues(raw: unknown): Partial<Record<DraftField, string>> {
	const values: Partial<Record<DraftField, string>> = {};
	if (typeof raw !== "object" || raw === null) return values;
	const record = raw as Record<string, unknown>;
	for (const field of DRAFT_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && value.length > 0 && value.length <= maxStoredLength(field)) {
			values[field] = value;
		}
	}
	return values;
}

function cleanErrors(raw: unknown): Partial<Record<DraftField, DraftFieldError>> {
	const errors: Partial<Record<DraftField, DraftFieldError>> = {};
	if (typeof raw !== "object" || raw === null) return errors;
	const record = raw as Record<string, unknown>;
	for (const field of DRAFT_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && FIELD_ERRORS.has(value)) {
			errors[field] = value as DraftFieldError;
		}
	}
	return errors;
}

function clean(raw: unknown): CheckoutDraft | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const draft: CheckoutDraft = {
		values: cleanValues(record["values"]),
		errors: cleanErrors(record["errors"]),
	};
	const error = record["error"];
	if (typeof error === "string" && TOKEN_SHAPE.test(error)) draft.error = error;
	const coupon = record["coupon"];
	if (typeof coupon === "string" && coupon.length > 0 && coupon.length <= COUPON_MAX) {
		draft.coupon = coupon;
	}
	return draft;
}

export interface DraftCookieWriter {
	set(name: string, value: string, options: CookieSetOptions): void;
}

/**
 * Write the draft. A draft that would not fit a cookie is NOT written at all —
 * never a shortened one: an address line silently dropped from the form would
 * be placed without it. The buyer then sees the form empty, as before the draft
 * existed, rather than a form that looks whole and is not.
 */
export function writeCheckoutDraft(cookies: DraftCookieWriter, draft: CheckoutDraft): void {
	const candidate = clean(draft);
	if (candidate === null) return;
	if (encodeURIComponent(JSON.stringify(candidate)).length > COOKIE_BUDGET) return;
	cookies.set(CHECKOUT_DRAFT_COOKIE, JSON.stringify(candidate), {
		httpOnly: true,
		secure: true,
		sameSite: "strict",
		path: DRAFT_PATH,
		maxAge: CHECKOUT_DRAFT_MAX_AGE_SECONDS,
	});
}

export function readCheckoutDraft(cookies: CookieReader): CheckoutDraft | null {
	const raw = cookies.get(CHECKOUT_DRAFT_COOKIE)?.value;
	if (raw === undefined || raw.length === 0) return null;
	try {
		return clean(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function clearCheckoutDraft(cookies: CookieDeleter): void {
	cookies.delete(CHECKOUT_DRAFT_COOKIE, { path: DRAFT_PATH });
}

/** The form's typed fields, as posted (untrimmed: what the buyer sees again is
 *  what they typed). Blank fields are omitted. */
export function draftValuesFromForm(form: FormData): Partial<Record<DraftField, string>> {
	const values: Partial<Record<DraftField, string>> = {};
	for (const field of DRAFT_FIELDS) {
		const value = form.get(field);
		if (typeof value === "string" && value.trim().length > 0) values[field] = value;
	}
	return values;
}

/** Every address field the view fills, `""` where the draft has nothing. */
export function draftAddressValues(draft: CheckoutDraft | null): Record<DraftAddressField, string> {
	const values = {} as Record<DraftAddressField, string>;
	for (const field of DRAFT_ADDRESS_FIELDS) values[field] = draft?.values[field] ?? "";
	return values;
}

/** How the page asks for the address: `addressRequired` when it may not be left
 *  blank. The checkout page sets it for an India-based Stripe account (issue
 *  #382); a zoned delivery does not pass it yet, so its copy is unchanged. */
export interface FieldErrorContext {
	addressRequired?: boolean;
}

/** The sentence beside a refused field. */
export function fieldErrorCopy(
	field: DraftField,
	error: DraftFieldError,
	context: FieldErrorContext = {},
): string {
	if (error === "too_long") {
		const max = field === "email" ? BUYER_REF_MAX : ORDER_ADDRESS_MAX_LENGTHS[field];
		return `Too long — use at most ${max} characters.`;
	}
	if (field === "email") return "Enter an email address like name@example.com.";
	if (error === "missing") {
		return context.addressRequired === true
			? "Fill this in."
			: "Fill this in, or leave the whole address blank.";
	}
	if (field === "country") return "Choose a country from the list.";
	if (field === "region") return "Use a state/province code, e.g. CA — or leave it blank.";
	return "Check this field.";
}

/** The field errors this render shows: the draft's, only when the URL names the
 *  token they were recorded for. */
export function shownFieldErrors(
	draft: CheckoutDraft | null,
	error: string | null,
	context: FieldErrorContext = {},
): Partial<Record<DraftField, string>> {
	const shown: Partial<Record<DraftField, string>> = {};
	if (draft === null || error === null || draft.error !== error) return shown;
	for (const field of DRAFT_FIELDS) {
		const reason = draft.errors[field];
		if (reason !== undefined) shown[field] = fieldErrorCopy(field, reason, context);
	}
	return shown;
}
