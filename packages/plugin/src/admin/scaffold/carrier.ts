import { decodeJsonToken, encodeJsonToken } from "./base64url.js";

/**
 * The admin console's HIDDEN-CONTEXT carrier.
 *
 * THE PROBLEM. Block Kit has no hidden form field: `FormField` is the visible
 * element union (text/number/select/date/…), so an admin form that must thread
 * internal context through a STATELESS submit had only one place to put it — a
 * visible field. Every screen therefore grew a single-option `select` whose
 * label was the raw internal key, and operators were asked to "pick" an
 * `orderId`, an `expectedAmountCents`, or (in the refund form) an idempotency
 * `nonce`. Three near-identical local helpers existed for this
 * (`hiddenCarrier` / `idCarrier` / `stockCarrier`).
 *
 * THE MECHANISM. A block's `block_id` is echoed back on the interaction it
 * fires — verified in the pinned renderer (emdash 0.29.0
 * `packages/blocks/src/blocks/form.tsx:57` emits `block_id: block.block_id` on
 * `form_submit`; `table.tsx:55,64` does the same for a table's sort/load-more
 * `block_action`). So the context can ride in the form's `block_id` and the fake
 * dropdowns can be deleted. This module is the encode/decode pair for that
 * token; {@link ../list-detail.js the engine} recovers it from `input.block_id`
 * exactly like it recovers the drill path from `value.__path`.
 *
 * SHAPE + LIMITS, because five screens depend on them:
 *  - The payload is a FLAT `Record<string, string>` — no nesting, no numbers.
 *    Money crosses this boundary as its integer minor-unit string
 *    (`String(amountCents)`), never a float.
 *  - The token is opaque but NOT secret and NOT authenticated: it round-trips
 *    through the operator's browser, so a determined operator can rewrite it.
 *    Treat every decoded value as untrusted input and re-authorize server-side —
 *    the same rule that already applies to a `select`'s value.
 *  - `block_id` is ALSO the renderer's React key (`renderer.tsx:78`,
 *    `block.block_id ?? i`), which has two consequences a page team must design
 *    for. FIRST, two forms in ONE block list must not carry an IDENTICAL
 *    context — in practice every per-row form already carries its row id, which
 *    makes the token unique; a list that would otherwise collide must add a
 *    discriminator. SECOND, and easier to miss: the token doubles as a CHANGE
 *    TOKEN. Block Kit inputs are UNCONTROLLED (`text_input`/`select` render
 *    `defaultValue`), so a re-render that reuses a mounted form's key CANNOT
 *    refresh its prefilled values — the operator keeps seeing the old ones.
 *    {@link encodeCarrier} is a pure function of the context, so the key changes
 *    exactly when the carried context changes, which remounts the form and
 *    refreshes its `initial_value`s. THEREFORE: any value a form prefills and
 *    that can change server-side must be REFLECTED IN THE CARRIER (an
 *    `expectedAmountCents`/`expectedUpdatedAt`-style optimistic-concurrency
 *    value already does this by construction; a bare `{id}` carrier does not).
 *  - `PATH_FIELD` (`__path`, from `nav.ts`) is reserved: a carrier holding it also tells
 *    the engine which drill level the submit belongs to, which is what lets a
 *    deep filter form drop the visible "Scope" dropdown.
 *
 * IO-FREE: pure serialization, like `nav.ts`.
 */

/** The flat, string-only context a form carries through a stateless submit. */
export type CarriedContext = Readonly<Record<string, string>>;

/** Marks a `block_id` as a carrier token (`u1` = urumi carrier, version 1).
 *  Without it a plain `block_id` — one a page set purely as a React key — could
 *  be mistaken for context; with it {@link decodeCarrier} rejects anything that
 *  is not deliberately a carrier, and the version leaves room to change the
 *  payload encoding later without decoding an old token as a new one. */
export const CARRIER_PREFIX = "u1.";

/** A key that must never be accepted from a decoded token (assigning it would
 *  reach `Object.prototype`; JSON.parse makes it an OWN property, so it has to
 *  be rejected explicitly rather than relied on to be harmless). */
const FORBIDDEN_KEY = "__proto__";

/**
 * Encode `context` into a form's `block_id`. Deterministic for a given key
 * insertion order, so re-rendering a form does not churn its React key.
 */
export function encodeCarrier(context: CarriedContext): string {
	return CARRIER_PREFIX + encodeJsonToken(context);
}

/**
 * Recover a {@link CarriedContext} from a `block_id`.
 *
 * TOTAL by construction: absent, non-string, unprefixed, non-base64, non-JSON,
 * or wrongly-shaped input (an array, a scalar, a nested object, a non-string
 * value, a `__proto__` key) all yield `undefined`. It NEVER throws and never
 * returns a partially-trusted record — a token with one bad value is rejected
 * whole, because a mutation driven by half its context is worse than one that
 * fails closed.
 */
export function decodeCarrier(token: unknown): CarriedContext | undefined {
	if (typeof token !== "string" || !token.startsWith(CARRIER_PREFIX)) return undefined;
	let parsed: unknown;
	try {
		parsed = decodeJsonToken(token.slice(CARRIER_PREFIX.length));
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const entries = Object.entries(parsed);
	for (const [key, value] of entries) {
		if (key === FORBIDDEN_KEY || typeof value !== "string") return undefined;
	}
	return Object.fromEntries(entries) as CarriedContext;
}
