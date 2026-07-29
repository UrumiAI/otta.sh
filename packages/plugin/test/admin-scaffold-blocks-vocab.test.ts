import { describe, expect, test } from "vitest";
import {
	carriedForm,
	carrierNamespace,
	CARRIER_MARKER,
	decodeCarrier,
	emptyState,
	encodeCarrier,
	encodePath,
	carriedFields,
	filterPanel,
	filterPanelLabel,
	filterSummary,
	MAX_CARRIER_LENGTH,
	PATH_FIELD,
	PREFILL_FIELD,
} from "../src/admin/scaffold/index.js";
import type { AccordionBlock, FormBlock } from "../src/types.js";

/**
 * The shared layout vocabulary the six admin screens build on (admin-UX density
 * increment 1 + the engine half of increment 2): the `block_id` context carrier
 * that replaces the fake single-option "carrier" dropdowns, and the two layout
 * helpers (`filterPanel` / `emptyState`).
 *
 * PURE unit tests — none of this touches `ctx`, so there is nothing to boot a
 * workerd sandbox for. The ENGINE half (recovering carried context and the drill
 * path from `block_id` inside a live dispatch) is exercised under the real
 * sandbox in `admin-scaffold-list-detail.sandbox.test.ts`, and the compile-time
 * half (a carrier is not assignable to a non-echoing block) in
 * `admin-scaffold-carrier.type-test.ts`.
 */

describe("carrier token (form/table `block_id` hidden context)", () => {
	test("round-trips an arbitrary flat string record under its namespace", () => {
		// NOTE for anyone copying this: NO idempotency key or nonce is carried here,
		// deliberately — see the prohibition in `carrier.ts`. Derive it server-side
		// from the carried content plus the CAS watermark.
		const context = { orderId: "ord-1", currency: "USD", amountCents: "1999" };
		const token = encodeCarrier("orders:refund", context);
		expect(token.startsWith(`orders:refund${CARRIER_MARKER}`)).toBe(true);
		expect(decodeCarrier(token)).toEqual(context);
		expect(carrierNamespace(token)).toBe("orders:refund");
	});

	test("round-trips an empty record, and values that would break a naive encoding", () => {
		expect(decodeCarrier(encodeCarrier("x:y", {}))).toEqual({});
		const nasty = {
			// A `block_id` is also a React key and rides in a JSON body: prove the
			// encoding is opaque to whitespace, quotes, separators and non-ASCII.
			a: 'x"y\\z',
			b: "with spaces\nand\tnewlines",
			c: "sep.arators/and+slashes=padding",
			d: "unicode — ✓ 日本語",
			e: "",
			f: `looks:like:a${CARRIER_MARKER}nested token`,
		};
		expect(decodeCarrier(encodeCarrier("x:y", nasty))).toEqual(nasty);
	});

	test("splits on the LAST marker, so a namespace may contain colons and a value may contain the marker", () => {
		const token = encodeCarrier("shipping:zone:rate-edit", { note: `a${CARRIER_MARKER}b` });
		expect(carrierNamespace(token)).toBe("shipping:zone:rate-edit");
		expect(decodeCarrier(token)).toEqual({ note: `a${CARRIER_MARKER}b` });
	});

	test("is deterministic AND key-order independent (the key must change only when the context does)", () => {
		expect(encodeCarrier("a:b", { a: "1", b: "2" })).toBe(encodeCarrier("a:b", { a: "1", b: "2" }));
		// A screen building context with conditional spreads must not get a
		// different token — that would remount the form and discard typing.
		expect(encodeCarrier("a:b", { a: "1", b: "2" })).toBe(encodeCarrier("a:b", { b: "2", a: "1" }));
		// And the token DOES change when a value changes.
		expect(encodeCarrier("a:b", { a: "1", b: "2" })).not.toBe(
			encodeCarrier("a:b", { a: "1", b: "3" }),
		);
		// ...or when the namespace does, which is what keeps two sibling forms with
		// identical context from sharing a React key.
		expect(encodeCarrier("a:b", { a: "1" })).not.toBe(encodeCarrier("a:c", { a: "1" }));
	});

	test("decode is TOTAL: malformed, absent and hostile input yield undefined, never a throw", () => {
		const valid = encodeCarrier("orders:refund", { a: "1" });
		const payload = valid.slice(valid.lastIndexOf(CARRIER_MARKER) + CARRIER_MARKER.length);
		const hostile: unknown[] = [
			undefined,
			null,
			"",
			42,
			true,
			{},
			[],
			() => "nope",
			// Not a carrier at all — a plain `block_id` a page set for React keying
			// MUST NOT decode as context, including a spec-shaped one.
			"orders-filter",
			"orders:tabs",
			// Marker present but no namespace before it.
			`${CARRIER_MARKER}${payload}`,
			// Right marker, garbage payload.
			`ns:x${CARRIER_MARKER}!!!not-base64!!!`,
			`ns:x${CARRIER_MARKER}`,
			// Truncated payload (bit-misaligned base64).
			`ns:x${CARRIER_MARKER}${payload.slice(1)}`,
			// Raw base64 alphabet that base64url excludes, plus whitespace.
			`ns:x${CARRIER_MARKER}eyJhIjoiMSJ9==`,
			`ns:x${CARRIER_MARKER}eyJhIjoi MSJ9`,
			`ns:x${CARRIER_MARKER}\neyJhIjoiMSJ9`,
			// Valid base64url whose bytes are not valid UTF-8 JSON.
			`ns:x${CARRIER_MARKER}${b64("", "")}`,
			`ns:x${CARRIER_MARKER}_____w`,
			// Correct encoding, wrong shape (array / scalar / nested / non-string
			// values), and both flavours of prototype-pollution attempt.
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify(["a", "b"]))}`,
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify("a string"))}`,
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify(null))}`,
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify(7))}`,
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify({ a: { nested: "1" } }))}`,
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify({ a: 1 }))}`,
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify({ a: null }))}`,
			`ns:x${CARRIER_MARKER}${b64("", JSON.stringify({ a: ["1"] }))}`,
			`ns:x${CARRIER_MARKER}${b64("", '{"__proto__":{"polluted":"yes"}}')}`,
			`ns:x${CARRIER_MARKER}${b64("", '{"__proto__":"polluted"}')}`,
			`ns:x${CARRIER_MARKER}${b64("", '{"a":"1","__proto__":"polluted"}')}`,
			// Other `Object.prototype` names, which survive `fromEntries` as own
			// properties and make the record hostile to ordinary use.
			`ns:x${CARRIER_MARKER}${b64("", '{"constructor":"x"}')}`,
			`ns:x${CARRIER_MARKER}${b64("", '{"toString":"x"}')}`,
			`ns:x${CARRIER_MARKER}${b64("", "{not json")}`,
			// Over the length bound (checked BEFORE any decoding work).
			`ns:x${CARRIER_MARKER}${"A".repeat(MAX_CARRIER_LENGTH)}`,
			// Deeply nested JSON: `JSON.parse` raises a RangeError, which must be a
			// rejected token rather than a thrown route.
			`ns:x${CARRIER_MARKER}${b64("", `${"[".repeat(200_000)}${"]".repeat(200_000)}`)}`,
			// A correctly-shaped payload with no marker at all.
			b64("", JSON.stringify({ a: "1" })),
		];
		for (const input of hostile) {
			expect(() => decodeCarrier(input), `threw on ${preview(input)}`).not.toThrow();
			expect(decodeCarrier(input), `decoded ${preview(input)}`).toBeUndefined();
		}
		// Prototype pollution never reaches the returned object or `Object`.
		expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
	});

	test("a decoded context is a plain own-property record (no inherited keys)", () => {
		const decoded = decodeCarrier(encodeCarrier("ns:x", { a: "1" }));
		expect(decoded).toBeDefined();
		expect(Object.keys(decoded ?? {})).toEqual(["a"]);
		expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
	});

	test("encode REJECTS author mistakes loudly (they are not operator input)", () => {
		expect(() => encodeCarrier("", { a: "1" })).toThrowError(/invalid namespace/);
		expect(() => encodeCarrier("has space", { a: "1" })).toThrowError(/invalid namespace/);
		expect(() => encodeCarrier(`ns${CARRIER_MARKER}x`, { a: "1" })).toThrowError(
			/invalid namespace/,
		);
		expect(() => encodeCarrier("ns:x", { toString: "x" })).toThrowError(/reserved key/);
		expect(() => encodeCarrier("ns:x", { a: 1 } as unknown as Record<string, string>)).toThrowError(
			/must be a string/,
		);
		expect(() => encodeCarrier("ns:x", { a: "A".repeat(MAX_CARRIER_LENGTH) })).toThrowError(
			/exceeds 4096/,
		);
	});

	test("carries the reserved drill-path key so a form needs no visible carrier field", () => {
		const token = encodeCarrier("geo:filter", { [PATH_FIELD]: encodePath(["z1", "m2"]) });
		expect(decodeCarrier(token)?.[PATH_FIELD]).toBe(encodePath(["z1", "m2"]));
	});

	test("carrierNamespace is total too", () => {
		expect(carrierNamespace(undefined)).toBeUndefined();
		expect(carrierNamespace("orders:tabs")).toBeUndefined();
		expect(carrierNamespace(`${CARRIER_MARKER}payload`)).toBeUndefined();
	});
});

/** A form holding one secret input, whose `has_value` affordance the renderer reads
 *  once (`useState(!has_value)`) and never re-syncs. */
function withSecret(hasValue: boolean): FormBlock {
	return {
		type: "form",
		fields: [{ type: "secret_input", action_id: "token", label: "Token", has_value: hasValue }],
		submit: { label: "Save", action_id: "x:apply-filter" },
	};
}

/** A one-field filter form whose single field is prefilled with `value` (or not
 *  prefilled at all) — the `Clear filters` before/after shape. */
function prefilled(value: string | undefined): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "text_input",
				action_id: "status",
				label: "Status",
				...(value !== undefined ? { initial_value: value } : {}),
			},
		],
		submit: { label: "Apply filters", action_id: "orders:apply-filter" },
	};
}

describe("carriedForm (context + a key that tracks prefilled values)", () => {
	test("sets the form's block_id and leaves everything else identical", () => {
		const form = prefilled("paid");
		const carried = carriedForm({ namespace: "orders:filter", context: { a: "1" }, form });
		expect(carried.fields).toBe(form.fields);
		expect(carried.submit).toBe(form.submit);
		expect(carrierNamespace(carried.block_id)).toBe("orders:filter");
		expect(decodeCarrier(carried.block_id)?.["a"]).toBe("1");
	});

	test("the key CHANGES when a prefilled value changes — the `Clear filters` fix", () => {
		const filtered = carriedForm({ namespace: "orders:filter", form: prefilled("paid") });
		const cleared = carriedForm({ namespace: "orders:filter", form: prefilled(undefined) });
		// Same context, same namespace, DIFFERENT prefill ⇒ different React key, so
		// the uncontrolled inputs remount and show the cleared values. Without this
		// the fields keep showing `paid` and the next submit re-applies it.
		expect(cleared.block_id).not.toBe(filtered.block_id);
		expect(decodeCarrier(cleared.block_id)?.[PREFILL_FIELD]).not.toBe(
			decodeCarrier(filtered.block_id)?.[PREFILL_FIELD],
		);
	});

	test("the key is STABLE when nothing changed (an unrelated re-render keeps the operator's typing)", () => {
		expect(
			carriedForm({ namespace: "orders:filter", context: { a: "1" }, form: prefilled("paid") })
				.block_id,
		).toBe(
			carriedForm({ namespace: "orders:filter", context: { a: "1" }, form: prefilled("paid") })
				.block_id,
		);
	});

	test("the digest covers field identity and order, not just values", () => {
		const base = prefilled("paid");
		const renamed: FormBlock = {
			...base,
			fields: [{ type: "text_input", action_id: "state", label: "Status", initial_value: "paid" }],
		};
		expect(carriedForm({ namespace: "n:s", form: renamed }).block_id).not.toBe(
			carriedForm({ namespace: "n:s", form: base }).block_id,
		);
	});

	test("a caller-supplied `__v` is REJECTED rather than silently clobbered", () => {
		expect(() =>
			carriedForm({
				namespace: "orders:filter",
				context: { __v: "mine" },
				form: prefilled("paid"),
			}),
		).toThrowError(/__v is reserved/);
	});

	test("carriedFields strips the reserved keys, so a screen can iterate its own context", () => {
		const carried = carriedForm({
			namespace: "geo:filter",
			context: { [PATH_FIELD]: encodePath(["c1"]), zoneId: "us" },
			form: prefilled("paid"),
		});
		const raw = decodeCarrier(carried.block_id);
		// The raw record carries both reserved keys — engine business.
		expect(Object.keys(raw ?? {}).toSorted()).toEqual(["__path", "__v", "zoneId"]);
		// What a screen sees does not.
		expect(carriedFields(raw ?? {})).toEqual({ zoneId: "us" });
	});

	test("context still round-trips alongside the digest", () => {
		const carried = carriedForm({
			namespace: "tax:rate-edit",
			context: { classId: "std", rateId: "r1", expectedRateBps: "725" },
			form: prefilled("paid"),
		});
		const decoded = decodeCarrier(carried.block_id);
		expect(decoded?.["classId"]).toBe("std");
		expect(decoded?.["expectedRateBps"]).toBe("725");
		expect(decoded?.[PREFILL_FIELD]).toBeDefined();
	});
});

/** A filter form with `fieldCount` text fields, CARRIED — `filterPanel` requires
 *  every form to come from `carriedForm`, so this is the shape a screen ships.
 *  Use {@link formWith} for the raw, uncarried form. */
function carriedFormWith(fieldCount: number): FormBlock {
	return carriedForm({ namespace: "x:filter", form: formWith(fieldCount) });
}

/** A filter form with `fieldCount` text fields — the only thing `filterPanel`
 *  keys off is how many fields the screen authored. */
function formWith(fieldCount: number): FormBlock {
	return {
		type: "form",
		fields: Array.from({ length: fieldCount }, (_unused, i) => ({
			type: "text_input" as const,
			action_id: `f${i}`,
			label: `F${i}`,
		})),
		submit: { label: "Apply filters", action_id: "x:apply-filter" },
	};
}

describe("filterPanel (a filter form that costs no screenful of scroll)", () => {
	test("a small filter (≤ 2 fields) renders INLINE — the form itself, untouched", () => {
		const one = carriedFormWith(1);
		expect(filterPanel({ form: one, blockId: "x:filters" })).toBe(one);
		const two = carriedFormWith(2);
		expect(filterPanel({ form: two, blockId: "x:filters", activeFilters: ["status: paid"] })).toBe(
			two,
		);
	});

	test("a 3+ field filter collapses into a CLOSED accordion holding the form", () => {
		const form = carriedFormWith(4);
		const panel = filterPanel({ form, blockId: "orders:filters" });
		expect(panel).toEqual({
			type: "accordion",
			label: "Filters",
			blocks: [form],
			block_id: "orders:filters",
		});
		// Closed always, and expressed by OMITTING default_open: em-dash reads it
		// once in a useState initialiser, so it cannot be used as state anyway.
		expect("default_open" in panel).toBe(false);
	});

	test("the collapsed label is a COUNT, never the values (spec L-3)", () => {
		const panel = filterPanel({
			form: carriedFormWith(4),
			blockId: "orders:filters",
			activeFilters: ["status: paid", "from: 2026-07-01"],
		});
		// A label is a control with a tight width budget: no values, no truncation,
		// no ellipsis. The values live in the section beneath, via `filterSummary`.
		expect((panel as AccordionBlock).label).toBe("Filters (2 active)");
	});

	test("filterPanelLabel counts only, and says nothing when nothing is active", () => {
		expect(filterPanelLabel("Filters", 0)).toBe("Filters");
		expect(filterPanelLabel("Filters", 1)).toBe("Filters (1 active)");
		expect(filterPanelLabel("Rate filter", 3)).toBe("Rate filter (3 active)");
		// Defensive: a negative count is treated as none rather than rendered.
		expect(filterPanelLabel("Filters", -1)).toBe("Filters");
	});

	test("the count comes from the SAME array as the summary, so they cannot disagree", () => {
		const parts: ReadonlyArray<string | false | null | undefined> = [
			false,
			"zone: us",
			undefined,
			"",
			"ships: yes",
			null,
		];
		const panel = filterPanel({
			form: carriedFormWith(3),
			blockId: "tax:filters",
			activeFilters: parts,
		});
		expect((panel as AccordionBlock).label).toBe("Filters (2 active)");
		expect(filterSummary(parts)).toBe("zone: us · ships: yes");
	});

	test("label + inlineUpTo are honoured; blockId is required and is a React key only", () => {
		const form = carriedFormWith(1);
		// inlineUpTo: 0 forces the accordion even for a single field.
		expect(
			filterPanel({
				form,
				blockId: "tax:filters:std",
				label: "Rate filter",
				activeFilters: ["zone: us"],
				inlineUpTo: 0,
			}),
		).toEqual({
			type: "accordion",
			label: "Rate filter (1 active)",
			blocks: [form],
			block_id: "tax:filters:std",
		});
	});

	test("more than 4 filter fields THROWS rather than silently hiding a spec violation", () => {
		expect(() => filterPanel({ form: carriedFormWith(5), blockId: "x:filters" })).toThrowError(
			/5 filter fields exceeds the 4-field maximum/,
		);
	});

	test("ANY form without a matching prefill digest THROWS — every filter form comes from carriedForm", () => {
		// Unconditional on purpose. A form whose React key cannot move when its
		// prefilled values change strands them on screen (`Clear filters` leaves the
		// old value visible and the next submit re-applies it), and nesting makes the
		// key permanent — a form inside an accordion is index 0 of that accordion
		// forever. Requiring the digest even when nothing is prefilled TODAY means the
		// first render test on every screen trips this, and a filter that gains a
		// prefill later cannot quietly become wrong.
		expect(() => filterPanel({ form: formWith(3), blockId: "x:filters" })).toThrowError(
			/carries no prefill digest/,
		);
		const prefilledForm: FormBlock = {
			...formWith(3),
			fields: [
				{ type: "text_input", action_id: "status", label: "Status", initial_value: "paid" },
				{ type: "text_input", action_id: "q", label: "Search" },
				{ type: "text_input", action_id: "z", label: "Zone" },
			],
		};
		expect(() => filterPanel({ form: prefilledForm, blockId: "x:filters" })).toThrowError(
			/carries no prefill digest/,
		);
		// Through `carriedForm`, both are accepted.
		for (const form of [formWith(3), prefilledForm]) {
			expect(() =>
				filterPanel({
					form: carriedForm({ namespace: "orders:filter", form }),
					blockId: "x:filters",
				}),
			).not.toThrow();
		}
	});

	test("a STALE digest throws too — presence alone would let a hand-rolled token through", () => {
		const form = carriedForm({
			namespace: "orders:filter",
			form: formWith(3),
		});
		// Editing the form AFTER carrying it leaves the digest describing the old
		// fields, i.e. exactly the stale React key the digest exists to prevent.
		const edited: FormBlock = {
			...form,
			fields: [{ type: "text_input", action_id: "status", label: "Status", initial_value: "paid" }],
		};
		expect(() => filterPanel({ form: edited, blockId: "x:filters" })).toThrowError(
			/carries a STALE prefill digest/,
		);
		// And a hand-rolled token that merely CONTAINS the reserved key does not pass.
		const faked: FormBlock = {
			...formWith(3),
			block_id: encodeCarrier("orders:filter", { [PREFILL_FIELD]: "1" }),
		};
		expect(() => filterPanel({ form: faked, blockId: "x:filters" })).toThrowError(
			/carries a STALE prefill digest/,
		);
	});

	test("the digest covers a secret input's `has_value`, which the renderer reads once and never re-syncs", () => {
		// `SecretInputElementComponent` does `useState(!element.has_value)`, so a
		// re-render that flips `has_value` without a key change shows an empty editable
		// field where the masked "value is set" affordance belongs.
		expect(carriedForm({ namespace: "n:s", form: withSecret(true) }).block_id).not.toBe(
			carriedForm({ namespace: "n:s", form: withSecret(false) }).block_id,
		);
	});

	test("the form's own carrier is left alone — the accordion keeps its own plain key", () => {
		const form = carriedForm({
			namespace: "tax:filter",
			context: { [PATH_FIELD]: encodePath(["z1"]) },
			form: formWith(3),
		});
		const panel = filterPanel({ form, blockId: "tax:filters" }) as AccordionBlock;
		expect(panel.block_id).toBe("tax:filters");
		expect((panel.blocks[0] as FormBlock).block_id).toBe(form.block_id);
	});
});

describe("emptyState (a real `empty` block)", () => {
	test("emits the minimal block from a title alone", () => {
		expect(emptyState({ title: "No orders yet" })).toEqual({
			type: "empty",
			title: "No orders yet",
		});
	});

	test("maps every optional to em-dash's snake_case field, omitting what is absent", () => {
		const actions = [{ type: "button" as const, action_id: "x:new", label: "New" }];
		expect(
			emptyState({
				title: "No products",
				description: "Publish one to see it here.",
				size: "sm",
				actions,
				blockId: "products-empty",
			}),
		).toEqual({
			type: "empty",
			title: "No products",
			description: "Publish one to see it here.",
			size: "sm",
			actions,
			block_id: "products-empty",
		});
	});

	test("drops an empty actions array rather than emitting an empty button row", () => {
		expect(emptyState({ title: "T", actions: [] })).toEqual({ type: "empty", title: "T" });
	});
});

/** Base64url-encode `json` behind `prefix` — the test's own encoder, so a
 *  malformed payload can be constructed without going through `encodeCarrier`. */
function b64(prefix: string, json: string): string {
	const bytes = new TextEncoder().encode(json);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return prefix + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A short, safe rendering of a hostile input for an assertion message. */
function preview(input: unknown): string {
	const text = typeof input === "string" ? input : String(input);
	return text.length > 60 ? `${text.slice(0, 60)}… (${text.length} chars)` : text;
}
