/**
 * The shapes the payment and email keys on the Settings screen must have
 * (U-8, QA 2026-10-02).
 *
 * WHY THE SAVE CHECKS A SHAPE. Every one of these keys used to be stored exactly
 * as typed. A publishable key pasted into the secret-key box, a webhook secret
 * with a trailing newline from a copy, or a Stripe key in the email box all
 * saved with "saved", and the failure surfaced later as a checkout or an email
 * that never worked, on a path the operator does not watch. Each check here is
 * the prefix (and alphabet) the provider issues, so it catches a wrong paste,
 * not a wrong account: a well-shaped key the provider rejects is still the
 * provider's answer to give.
 *
 * Every check TRIMS first and hands back the trimmed value — that is the value
 * to store. A reason never contains the value: it names the shape.
 *
 * SANDBOX-CLEAN. Pure functions, no IO.
 */

export type SecretShapeCheck = { ok: true; value: string } | { ok: false; problem: string };

/** The longest key any of these fields accepts. Real ones are far shorter; this
 *  only stops a pasted document from being stored. */
const MAX_KEY_LENGTH = 512;

/** One line of printable ASCII with no spaces — what every one of these keys
 *  is, and what an HTTP header (where most of them end up) can carry. */
const OPAQUE_TOKEN = /^[\x21-\x7e]+$/;

function opaque(raw: string): SecretShapeCheck {
	const value = raw.trim();
	if (value.length > MAX_KEY_LENGTH) {
		return { ok: false, problem: `is longer than ${String(MAX_KEY_LENGTH)} characters` };
	}
	if (!OPAQUE_TOKEN.test(value)) {
		return { ok: false, problem: "must be one line with no spaces" };
	}
	return { ok: true, value };
}

/** Any key with no provider-specific shape: one line, no spaces, printable ASCII. */
export function checkOpaqueToken(raw: string): SecretShapeCheck {
	return opaque(raw);
}

/** `sk_live_` / `sk_test_`, or a restricted `rk_live_` / `rk_test_`, then the
 *  key body Stripe issues (letters and digits today; `_` is let through so a
 *  future body format is not refused for it). */
const STRIPE_SECRET_KEY = /^(?:sk|rk)_(test|live)_[A-Za-z0-9_]{10,}$/;

export function checkStripeSecretKey(raw: string): SecretShapeCheck {
	const base = opaque(raw);
	if (!base.ok) return base;
	if (!STRIPE_SECRET_KEY.test(base.value)) {
		return {
			ok: false,
			problem:
				"must start with sk_live_ or sk_test_ (or rk_live_ / rk_test_ for a restricted key). The publishable key (pk_…) goes in the storefront, not here",
		};
	}
	return base;
}

/** Test or live, read from a stored Stripe key's prefix — a fact about the key,
 *  never any part of it. `undefined` for a value saved before shapes were
 *  checked. */
export function stripeKeyMode(value: string): "test" | "live" | undefined {
	const match = STRIPE_SECRET_KEY.exec(value);
	return match?.[1] === "test" ? "test" : match?.[1] === "live" ? "live" : undefined;
}

/** `whsec_` then the signing secret (base64 alphabet, plus `_`, as above). */
const STRIPE_WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_]{10,}$/;

export function checkStripeWebhookSecret(raw: string): SecretShapeCheck {
	const base = opaque(raw);
	if (!base.ok) return base;
	if (!STRIPE_WEBHOOK_SECRET.test(base.value)) {
		return {
			ok: false,
			problem: "must start with whsec_ — copy it from the webhook endpoint in Stripe",
		};
	}
	return base;
}

/** `re_` then letters, digits and underscores: a Resend API key. */
const RESEND_API_KEY = /^re_[A-Za-z0-9_]{10,}$/;

/** Is the configured email endpoint Resend's — the one provider DEPLOYMENT.md
 *  documents and `ctx-http-email-sender.ts` speaks? */
export function isResendApiUrl(apiUrl: string | undefined): boolean {
	if (apiUrl === undefined) return false;
	try {
		return new URL(apiUrl).hostname === "api.resend.com";
	} catch {
		return false;
	}
}

/** `api-` then letters, digits, `_` and `-`: an SMTP2GO API key (its
 *  dashboard issues `api-` and a hex tail; the tail is checked loosely). */
const SMTP2GO_API_KEY = /^api-[A-Za-z0-9_-]{8,}$/;

/**
 * The key for the build's email URL (the Resend slot). When that URL is
 * Resend's the key must be a Resend key; any other endpoint (a local mail
 * catcher, a relay) only gets the one-line, no-spaces check, because this file
 * cannot know its format. An SMTP2GO key pasted here is refused with where it
 * belongs: the SMTP2GO API key field.
 */
export function checkEmailApiKey(raw: string, emailApiUrl: string | undefined): SecretShapeCheck {
	const base = opaque(raw);
	if (!base.ok) return base;
	if (isResendApiUrl(emailApiUrl) && !RESEND_API_KEY.test(base.value)) {
		return {
			ok: false,
			problem: SMTP2GO_API_KEY.test(base.value)
				? "must be a Resend API key, starting with re_ (an SMTP2GO key goes in the SMTP2GO API key field)"
				: "must be a Resend API key, starting with re_",
		};
	}
	return base;
}

/** The SMTP2GO API key: `api-…`, in its own slot. */
export function checkSmtp2goApiKey(raw: string): SecretShapeCheck {
	const base = opaque(raw);
	if (!base.ok) return base;
	return SMTP2GO_API_KEY.test(base.value)
		? base
		: { ok: false, problem: "must be an SMTP2GO API key, starting with api-" };
}
