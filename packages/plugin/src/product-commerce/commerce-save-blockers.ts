/**
 * The SAVE-BLOCKING predicate for the "Product data" widget's `commerce` field
 * bag — the upstream half of the money guard.
 *
 * ── Why this is NOT `parseCommerceFields` ─────────────────────────────────
 * `parse-commerce-fields.ts` is a DERIVE guard, answering "is there enough
 * here to build a valid upsert body?". It errors on ABSENCE as well as on
 * wrongness: `{currency:"USD"}` with no price yields `errors.price`, and a
 * currency cleared back to the `Select…` placeholder yields `errors.currency`.
 * Both are ordinary widget gestures (em-dash's `BlockKitFieldWidget` emits
 * `undefined` for a cleared number input and `""` for a select placeholder), so
 * reusing it as a SAVE blocker would make legitimately unpriced products
 * permanently unsaveable — strictly worse than the bug this closes. It is
 * therefore left untouched and is deliberately NOT used here.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * Block only PRESENT-AND-WRONG. Absent, cleared (`undefined`) and `""` are
 * always clean, which keeps two things true:
 *   - an unpriced product stays saveable (the "create-then-price" flow);
 *   - clearing the price input is ALWAYS an escape hatch back to a saveable
 *     state, so a merchant can never be trapped by a value they can't fix.
 *
 * Zero is valid (parity with the derive guard's `>= 0`); the domain's
 * `price > 0` rule stays where it belongs, in the service.
 *
 * Pure module — no IO, no `Date`, no crypto. It runs inline on the CMS save
 * critical path inside the sandbox.
 */

/** One present-and-wrong field. `value` is the merchant's raw input; the
 *  message layer (`commerce-rejection-message.ts`) owns all rendering. */
export interface Blocker {
	/** The widget `action_id` / bag key. */
	field: string;
	/** Merchant-facing field name, as the widget labels it. */
	label: string;
	/** The offending value, verbatim. */
	value: unknown;
	/** What the field must be, phrased for a merchant. */
	expected: string;
}

/**
 * True when the text carries a C0, DEL or C1 control character — newlines and
 * tabs included. A sku must be ONE CLEAN LINE: it ends up in a service
 * identifier, in log lines, and — when it is the offending value — inside the
 * rejection key, which em-dash validates as an identifier.
 *
 * A codepoint scan rather than a character-class regex on purpose: the regex
 * spelling trips oxlint's `no-control-regex` even with `\uXXXX` escapes. This
 * is also the single source of the range — `commerce-rejection-message.ts`
 * imports it to build its stripper.
 */
export function hasControlChars(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}
const ISO_4217 = /^[A-Z]{3}$/;
/** em-dash caps identifiers at 128; the service's sku column matches. */
const MAX_SKU_LENGTH = 128;

const WHOLE_NUMBER_EXPECTED = "must be a whole number, 0 or more";

/** A quantity/dimension the widget renders as a `number_input`. */
const COUNTED_FIELDS: ReadonlyArray<readonly [field: string, label: string]> = [
	["onHand", "Stock"],
	["weightGrams", "Weight"],
	["lengthMm", "Length"],
	["widthMm", "Width"],
	["heightMm", "Height"],
];

function isSafeNonNegativeInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A bag key counts as PRESENT only when it carries a defined value — a cleared
 *  number input emits `undefined`, which `JSON.stringify` drops anyway. */
function isPresent(bag: Record<string, unknown>, field: string): boolean {
	return field in bag && bag[field] !== undefined;
}

/** Emptiness is classified on the TRIMMED value so an invisible `"   "` is not
 *  mistaken for a deliberate clear. Non-strings are never "empty" — they are
 *  present-and-wrong. */
function isBlankString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length === 0;
}

/**
 * The present-and-wrong fields in a widget commerce bag, in a deterministic,
 * declaration-order list. A non-object / array / absent bag is a clean no-op
 * (matching the derive path's own defensiveness) — the merchant has not entered
 * anything we can reject.
 */
export function commerceSaveBlockers(bag: unknown): Blocker[] {
	if (typeof bag !== "object" || bag === null || Array.isArray(bag)) return [];
	const fields = bag as Record<string, unknown>;
	const blockers: Blocker[] = [];

	// -- price: THE money field (CLAUDE.md: integer minor units, never a float) --
	if (isPresent(fields, "price") && !isSafeNonNegativeInteger(fields["price"])) {
		blockers.push({
			field: "price",
			label: "Price",
			value: fields["price"],
			expected: "must be whole minor units (2499 = $24.99)",
		});
	}

	// -- currency: `""` is the select's placeholder, i.e. cleared, i.e. clean ---
	if (isPresent(fields, "currency") && !isBlankString(fields["currency"])) {
		const currency = fields["currency"];
		if (typeof currency !== "string" || !ISO_4217.test(currency)) {
			blockers.push({
				field: "currency",
				label: "Currency",
				value: currency,
				expected: "must be a 3-letter code like USD",
			});
		}
	}

	// -- sku ------------------------------------------------------------------
	// `""` / absent are clean (a product may legitimately have no sku — afterSave
	// simply skips the upsert). But WHITESPACE-ONLY is present-and-wrong:
	// `parse-commerce-fields.ts` accepts any non-empty string, so `"   "` would be
	// derived and PUT to the service as a real SKU — the same silent-bad-write
	// class this module exists to close. We deliberately do NOT auto-trim: that
	// would silently rewrite the merchant's value and would need the derive guard
	// to agree on the trimmed form.
	if (isPresent(fields, "sku")) {
		const sku = fields["sku"];
		const blank = isBlankString(sku);
		if (!(typeof sku === "string" && sku.length === 0)) {
			if (blank) {
				blockers.push({
					field: "sku",
					label: "SKU",
					value: sku,
					expected: "SKU cannot be blank",
				});
			} else if (typeof sku !== "string" || sku.length > MAX_SKU_LENGTH || hasControlChars(sku)) {
				blockers.push({
					field: "sku",
					label: "SKU",
					value: sku,
					expected: `must be one clean line, max ${MAX_SKU_LENGTH} chars`,
				});
			}
		}
	}

	// -- stock + dimensions ----------------------------------------------------
	for (const [field, label] of COUNTED_FIELDS) {
		if (isPresent(fields, field) && !isSafeNonNegativeInteger(fields[field])) {
			blockers.push({ field, label, value: fields[field], expected: WHOLE_NUMBER_EXPECTED });
		}
	}

	// -- productKind: `""` is the select's placeholder --------------------------
	if (isPresent(fields, "productKind") && !isBlankString(fields["productKind"])) {
		const kind = fields["productKind"];
		if (kind !== "physical" && kind !== "digital") {
			blockers.push({
				field: "productKind",
				label: "Product kind",
				value: kind,
				expected: "must be physical or digital",
			});
		}
	}

	// -- taxClass: any text is a legal class code; only a non-string is wrong ---
	if (isPresent(fields, "taxClass") && !isBlankString(fields["taxClass"])) {
		if (typeof fields["taxClass"] !== "string") {
			blockers.push({
				field: "taxClass",
				label: "Tax class",
				value: fields["taxClass"],
				expected: "must be text",
			});
		}
	}

	return blockers;
}
