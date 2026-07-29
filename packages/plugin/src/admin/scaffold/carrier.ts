import type { CarrierBlockId, FormBlock } from "../../types.js";
import { decodeJsonToken, encodeJsonText } from "./base64url.js";
import { PATH_FIELD } from "./nav.js";

/**
 * The admin console's HIDDEN-CONTEXT carrier.
 *
 * THE PROBLEM. Block Kit declares no hidden form field: `FormField` is the
 * visible element union (text/number/select/date/toggle/combobox/…), so an admin
 * form that must thread internal context through a STATELESS submit had only one
 * place to put it — a visible field. Every screen therefore grew a single-option
 * `select` whose label was the raw internal key, and operators were asked to
 * "pick" an `orderId` or an `expectedAmountCents`. Three near-identical local
 * helpers existed for this (`hiddenCarrier` / `idCarrier` / `stockCarrier`).
 *
 * (One near-miss, for the record: `FormField.condition` plus `form.tsx`'s
 * `getInitialValues` — which reads EVERY field's `initial_value` while the render
 * pass returns `null` for condition-false ones — does yield an emergent
 * submitted-but-never-rendered field. Considered and REJECTED: it rests on an
 * interaction between two upstream implementation details that a future release
 * could legitimately change, and it does nothing for tables.)
 *
 * THE MECHANISM. `form` and `table` echo their `block_id` back on the interaction
 * they fire, so context can ride there. Verified in the installed 0.31.1
 * renderer — exactly three echo sites exist: `blocks/form.tsx` on `form_submit`,
 * and `blocks/table.tsx` twice (sortable-header click, "Load more"). The
 * `block_id` plumbing is unchanged 0.29.0 → 0.31.1.
 *
 * **`button` INTERACTIONS CARRY NO `block_id`.** Neither does a `section`
 * accessory, nor an `empty` block's actions: `ButtonElementComponent` fires
 * `{type:"block_action", action_id, value}` and nothing else, and the blocks that
 * hold elements call `renderElement(el, onAction)` without passing their own id.
 * A button's ONLY context channel is `ButtonElement.value`, which takes arbitrary
 * JSON and needs no encoding. Since every delete, status transition and drill-in
 * is a button, this is the mistake most worth not making — so `encodeCarrier`
 * returns a branded `CarrierBlockId` that ONLY `FormBlock.block_id` and
 * `TableBlock.block_id` accept. Putting one on an `actions`/`empty`/`section`
 * block is a compile error, not a runtime `undefined`.
 *
 * SHAPE + LIMITS, because five screens depend on them:
 *  - The payload is a FLAT `Record<string, string>` — no nesting, no numbers.
 *    Money crosses this boundary as its integer minor-unit string
 *    (`String(amountCents)`), never a float.
 *  - The token is opaque but NOT secret and NOT authenticated: it round-trips
 *    through the operator's browser as a DOM attribute, so a determined operator
 *    can rewrite it. Treat every decoded value as untrusted input and re-authorize
 *    server-side — the same rule that already applied to a `select`'s value.
 *  - **NEVER CARRY AN IDEMPOTENCY KEY OR NONCE HERE.** Derive it server-side from
 *    the carried content: `${verb}:${id}:${amountMinorUnits}:${watermark}`. A
 *    carried nonce round-trips through the client, so the same nonce can return
 *    with a different amount, and the store's once-only guarantee will report that
 *    second, legitimate command as an already-applied duplicate:
 *    `domain/src/orders/refund-order.ts` resolves a refund by key ALONE and
 *    returns `{ok:true, duplicate:true}` without comparing amounts, so the operator
 *    would see a success-shaped "Already refunded" for money that never moved.
 *    Including the WATERMARK is what lets two deliberate identical refunds both
 *    apply. In-repo precedent: `orders-page.ts`'s
 *    `admin-transition:${orderId}:${toState}`, and `sync/derive-idempotency-key.ts`,
 *    whose header documents a real money-loss incident caused by a key that failed
 *    to change when its content did. (Issue #152 hardens `refundOrder` to reject
 *    key reuse with a differing amount; this rule holds regardless of that.)
 *  - `PATH_FIELD` (`__path`, from `nav.ts`) and {@link PREFILL_FIELD} (`__v`) are
 *    RESERVED keys. A carrier holding `__path` also tells the engine which drill
 *    level a submit belongs to, which is what lets a deep filter form drop its
 *    visible "Scope" dropdown.
 *  - `block_id` is ALSO the renderer's React key, and Block Kit inputs are
 *    UNCONTROLLED (`defaultValue`), so a re-render that reuses a mounted form's
 *    key CANNOT refresh its prefilled values. {@link carriedForm} exists so that
 *    property is structural rather than remembered: do not hand-roll the token for
 *    a form that prefills anything.
 *
 * IO-FREE: pure serialization, like `nav.ts`.
 */

/** The flat, string-only context a form carries through a stateless submit. */
export type CarriedContext = Readonly<Record<string, string>>;

/** Payload marker inside a `block_id` (`u1` = urumi carrier, version 1). A token
 *  is `<namespace>:u1.<base64url>`: the namespace keeps a carrier legible in
 *  devtools and distinct per form, and this marker is what makes a plain React key
 *  (`orders:tabs`) fail to decode as context. The version leaves room to change the
 *  payload encoding later without an old token decoding as a new one. */
export const CARRIER_MARKER = ":u1.";

/** Reserved carrier key holding a digest of the form's own prefilled values —
 *  {@link carriedForm} adds it so "prefill changed ⇒ React key changed" holds by
 *  construction. Ignore it when reading carried context. */
export const PREFILL_FIELD = "__v";

/** Hard bound on a whole token, checked BEFORE any decoding work. Generous: the
 *  largest real carrier is a handful of ids and watermarks. A `block_id` is a DOM
 *  attribute and a React key, not a transport. */
export const MAX_CARRIER_LENGTH = 4096;

/** Keys the mechanism owns: the drill level (`__path`, read by the engine's nav)
 *  and the prefill digest (`__v`, which only moves the React key). Stripped from
 *  what a screen sees — see {@link carriedFields}. */
const RESERVED_KEYS = new Set<string>([PATH_FIELD, PREFILL_FIELD]);

/** A namespace is the spec's `<entity>:<verb-or-noun>` — ASCII, no whitespace, and
 *  it must not itself contain the payload marker. */
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/** The base64url alphabet, exactly — no padding, no whitespace. Checked before
 *  `atob`, which per spec STRIPS ASCII whitespace and would otherwise accept
 *  `u1.eyJhIjoi MSJ9` as a valid carrier. A token is either byte-for-byte what
 *  `encodeCarrier` minted or it is not a carrier. */
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Encode `context` into a `<namespace>:u1.<base64url>` token for a form's (or
 * table's) `block_id`.
 *
 * `namespace` is the spec's `<entity>:<verb-or-noun>` — `"orders:refund"`,
 * `"tax:rate-edit"`. It is not decoded as context; it exists so a token is legible
 * in devtools and so two sibling forms with IDENTICAL context still get DIFFERENT
 * React keys.
 *
 * **A NAMESPACE IS A LITERAL — NEVER INTERPOLATED RECORD DATA.** `` `shipping:zone:${zone.id}` ``
 * is only safe if ids are known to match {@link NAMESPACE_PATTERN};
 * `` `shipping:zone:${zone.name}` `` is a latent outage, because a zone named
 * `"EU West"` throws. It is data-dependent, so fixtures pass and production does
 * not. Put the distinguishing value in the CONTEXT (where any string is legal) and
 * keep the namespace a constant describing the form's role.
 *
 * Throws on a programming error — a malformed namespace, a prototype key name, a
 * non-string value, or a token over {@link MAX_CARRIER_LENGTH}. Those are author
 * mistakes, not operator input. Every render path in
 * `createListDetailHandler` contains a throw and fails closed to a banner (verified
 * by its own suite), so the blast radius is one screen rendering an error state —
 * never a raw non-2xx that unmounts the page.
 */
export function encodeCarrier(namespace: string, context: CarriedContext): CarrierBlockId {
	if (!NAMESPACE_PATTERN.test(namespace) || namespace.includes(CARRIER_MARKER)) {
		throw new Error(`carrier: invalid namespace ${JSON.stringify(namespace)}`);
	}
	for (const [key, value] of Object.entries(context)) {
		if (isUnsafeKey(key)) throw new Error(`carrier: reserved key ${JSON.stringify(key)}`);
		if (typeof value !== "string") {
			throw new TypeError(`carrier: value for ${JSON.stringify(key)} must be a string`);
		}
	}
	const token = namespace + CARRIER_MARKER + encodeJsonText(stableJson(context));
	if (token.length > MAX_CARRIER_LENGTH) {
		throw new Error(`carrier: token exceeds ${MAX_CARRIER_LENGTH} chars (${token.length})`);
	}
	// SAFETY: the brand is phantom and this function is its ONLY mint — everything
	// the brand claims has just been validated above.
	return token as CarrierBlockId;
}

/**
 * Recover a {@link CarriedContext} from a `block_id`, splitting on the LAST
 * occurrence of the payload marker (a namespace legitimately contains `:`).
 *
 * TOTAL by construction: absent, non-string, over-long, marker-less, empty-namespace,
 * non-canonical-base64url (padding or whitespace included — see
 * {@link PAYLOAD_PATTERN}), non-JSON, or wrongly-shaped input (an array, a scalar, a
 * nested object, a non-string value, a prototype key) all yield `undefined`. It NEVER
 * throws — not even on a payload deep enough to blow the JSON parser's stack — and
 * never returns a partially-trusted record: a token with one bad value is rejected
 * whole, because a mutation driven by half its context is worse than one that fails
 * closed.
 */
export function decodeCarrier(token: unknown): CarriedContext | undefined {
	if (typeof token !== "string" || token.length > MAX_CARRIER_LENGTH) return undefined;
	const at = token.lastIndexOf(CARRIER_MARKER);
	// `at < 1` also rejects an EMPTY namespace (a bare `:u1.…`).
	if (at < 1) return undefined;
	const payload = token.slice(at + CARRIER_MARKER.length);
	if (!PAYLOAD_PATTERN.test(payload)) return undefined;
	let parsed: unknown;
	try {
		parsed = decodeJsonToken(payload);
	} catch {
		// Includes the RangeError a deeply-nested payload raises inside `JSON.parse`:
		// that must be a rejected token, never a thrown route.
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const entries = Object.entries(parsed);
	for (const [key, value] of entries) {
		if (isUnsafeKey(key) || typeof value !== "string") return undefined;
	}
	return Object.fromEntries(entries) as CarriedContext;
}

/**
 * A decoded record WITHOUT the reserved keys — the screen's own fields only.
 *
 * `__path` is the engine's (the drill level a submit belongs to) and `__v` is
 * `carriedForm`'s prefill digest, which exists purely to move the React key. A
 * screen that iterates its carried context should never have to know either
 * exists, so `readCarrier`/`CustomActionApi.carried` return this rather than the
 * raw record. The ENGINE still reads the raw record via {@link decodeCarrier}.
 */
export function carriedFields(context: CarriedContext): CarriedContext {
	return Object.fromEntries(
		Object.entries(context).filter(([key]) => !RESERVED_KEYS.has(key)),
	) as CarriedContext;
}

/** The namespace a carrier token declares (everything before the last marker), or
 *  `undefined` when the token is not a carrier — so a screen's test can assert
 *  WHICH form fired, and the engine can tell two sibling forms apart. */
export function carrierNamespace(token: unknown): string | undefined {
	if (typeof token !== "string" || token.length > MAX_CARRIER_LENGTH) return undefined;
	const at = token.lastIndexOf(CARRIER_MARKER);
	return at < 1 ? undefined : token.slice(0, at);
}

/**
 * Build a form that carries `context` invisibly AND remounts whenever its own
 * prefilled values change. USE THIS INSTEAD OF SETTING `block_id` BY HAND.
 *
 * Two properties, both easy to lose by hand:
 *  1. The context rides in `block_id`, so no visible plumbing field is needed.
 *  2. The token includes a digest of every field's `initial_value` under
 *     {@link PREFILL_FIELD}. Block Kit inputs are UNCONTROLLED, so React picks up a
 *     new `initial_value` only when the element REMOUNTS, and it remounts only when
 *     its key changes. Nesting makes this bite: a form inside an `accordion` is
 *     index 0 of that accordion's own nested render FOREVER, so it never gets the
 *     incidental remount a top-level form gets when a prepended banner shifts the
 *     indices — and "Clear filters" would re-render empty `initial_value`s into
 *     fields still showing the cleared filter, whose next submit re-applies it.
 *     Folding the prefill into the key makes "prefill changed ⇒ fields refresh"
 *     hold by construction.
 *
 * The digest is a short non-cryptographic hash (FNV-1a): this is a change token,
 * not a security boundary. A collision would merely miss a refresh, and the values
 * hashed are the ones already visible in the form.
 */
export function carriedForm(args: {
	namespace: string;
	context?: CarriedContext;
	form: FormBlock;
}): FormBlock {
	// A caller-supplied `__v` would be silently overwritten below. Clobbering in
	// that direction is safe (the digest is ours) but it is still silent data loss,
	// and the fix is to pick another key.
	if (args.context !== undefined && PREFILL_FIELD in args.context) {
		throw new Error(
			`carriedForm: ${PREFILL_FIELD} is reserved for the prefill digest — rename that context key`,
		);
	}
	return {
		...args.form,
		block_id: encodeCarrier(args.namespace, {
			...args.context,
			[PREFILL_FIELD]: prefillDigest(args.form),
		}),
	};
}

/** A digest of everything the form prefills — field identity, order, and the
 *  values React would only pick up on a remount. Exported so `filterPanel` can
 *  verify that a form's carried digest actually MATCHES the form it is attached to
 *  (a present-but-wrong digest is a stale React key, which is the bug the digest
 *  exists to prevent). */
export function prefillDigest(form: FormBlock): string {
	const material = form.fields.map((field) => [
		field.type,
		field.action_id,
		"initial_value" in field && field.initial_value !== undefined
			? String(field.initial_value)
			: "",
		"has_value" in field && field.has_value === true ? "1" : "",
	]);
	return fnv1a(JSON.stringify(material));
}

/** FNV-1a 32-bit, base36. Deterministic, allocation-light, and needs no crypto
 *  import (the Web Crypto digest is async; this runs inside a synchronous render). */
function fnv1a(input: string): string {
	let hash = 0x81_1c_9d_c5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
	}
	return hash.toString(36);
}

/** Reject any key that already names something on `Object.prototype`
 *  (`__proto__`, `constructor`, `toString`, …). `__proto__` would reach the
 *  prototype chain; the rest survive `Object.fromEntries` as own properties but
 *  make the record hostile to ordinary use (an interpolation of it throwing, say).
 *  No admin field is legitimately called any of these. */
function isUnsafeKey(key: string): boolean {
	return Reflect.has(Object.prototype, key);
}

/** Serialize with keys in SORTED order, so a token is a function of the context
 *  ALONE and not of the order a screen happened to build it in (a conditional
 *  spread — `{...(row.zoneId ? {zoneId} : {}), classId}` — would otherwise yield a
 *  different token for the same context, remounting the form and discarding the
 *  operator's unsubmitted typing). Written out rather than relying on object key
 *  order, so numeric-looking keys cannot reorder underneath us. */
function stableJson(context: CarriedContext): string {
	const parts = Object.keys(context)
		.toSorted()
		.map((key) => `${JSON.stringify(key)}:${JSON.stringify(context[key])}`);
	return `{${parts.join(",")}}`;
}
