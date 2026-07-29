import { describe, expect, test } from "vitest";
import {
	CARRIER_PREFIX,
	decodeCarrier,
	emptyState,
	encodeCarrier,
	encodePath,
	filterPanel,
	filterPanelLabel,
	PATH_FIELD,
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
 * sandbox in `admin-scaffold-list-detail.sandbox.test.ts`.
 */

describe("carrier token (form `block_id` hidden context)", () => {
	test("round-trips an arbitrary flat string record", () => {
		const context = { orderId: "ord-1", currency: "USD", nonce: "n-1" };
		const token = encodeCarrier(context);
		expect(token.startsWith(CARRIER_PREFIX)).toBe(true);
		expect(decodeCarrier(token)).toEqual(context);
	});

	test("round-trips an empty record, and values that would break a naive encoding", () => {
		expect(decodeCarrier(encodeCarrier({}))).toEqual({});
		const nasty = {
			// A `block_id` is also a React key and rides in a JSON body: prove the
			// encoding is opaque to whitespace, quotes, separators and non-ASCII.
			a: 'x"y\\z',
			b: "with spaces\nand\tnewlines",
			c: "sep.arators/and+slashes=padding",
			d: "unicode — ✓ 日本語",
			e: "",
		};
		expect(decodeCarrier(encodeCarrier(nasty))).toEqual(nasty);
	});

	test("is deterministic — the same record encodes to the same token", () => {
		expect(encodeCarrier({ a: "1", b: "2" })).toBe(encodeCarrier({ a: "1", b: "2" }));
	});

	test("decode is TOTAL: malformed, absent and hostile input yield undefined, never a throw", () => {
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
			// MUST NOT decode as context.
			"orders-filter",
			// Right prefix, garbage payload.
			`${CARRIER_PREFIX}!!!not-base64!!!`,
			`${CARRIER_PREFIX}`,
			// Valid base64url of things that are not a flat string record.
			`${CARRIER_PREFIX}${encodeCarrier({ a: "1" }).slice(CARRIER_PREFIX.length).slice(1)}`,
			// Correct encoding, wrong shape (array / scalar / nested / non-string
			// values), and both flavours of prototype-pollution attempt.
			b64(CARRIER_PREFIX, JSON.stringify(["a", "b"])),
			b64(CARRIER_PREFIX, JSON.stringify("a string")),
			b64(CARRIER_PREFIX, JSON.stringify(null)),
			b64(CARRIER_PREFIX, JSON.stringify(7)),
			b64(CARRIER_PREFIX, JSON.stringify({ a: { nested: "1" } })),
			b64(CARRIER_PREFIX, JSON.stringify({ a: 1 })),
			b64(CARRIER_PREFIX, JSON.stringify({ a: null })),
			b64(CARRIER_PREFIX, JSON.stringify({ a: ["1"] })),
			b64(CARRIER_PREFIX, '{"__proto__":{"polluted":"yes"}}'),
			b64(CARRIER_PREFIX, '{"__proto__":"polluted"}'),
			b64(CARRIER_PREFIX, '{"a":"1","__proto__":"polluted"}'),
			b64(CARRIER_PREFIX, "{not json"),
			// A correctly-shaped payload WITHOUT the prefix.
			b64("", JSON.stringify({ a: "1" })),
		];
		for (const input of hostile) {
			expect(() => decodeCarrier(input), `threw on ${String(input)}`).not.toThrow();
			expect(decodeCarrier(input), `decoded ${String(input)}`).toBeUndefined();
		}
		// Prototype pollution never reaches the returned object or `Object`.
		expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
	});

	test("a decoded context is a plain own-property record (no inherited keys)", () => {
		const decoded = decodeCarrier(encodeCarrier({ a: "1" }));
		expect(decoded).toBeDefined();
		expect(Object.keys(decoded ?? {})).toEqual(["a"]);
		expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
	});

	test("carries the reserved drill-path key so a form needs no visible carrier field", () => {
		const token = encodeCarrier({ [PATH_FIELD]: encodePath(["z1", "m2"]) });
		expect(decodeCarrier(token)?.[PATH_FIELD]).toBe(encodePath(["z1", "m2"]));
	});
});

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
		const one = formWith(1);
		expect(filterPanel({ form: one })).toBe(one);
		const two = formWith(2);
		expect(filterPanel({ form: two, summary: ["status: paid"] })).toBe(two);
	});

	test("a 3+ field filter collapses into a CLOSED accordion holding the form", () => {
		const form = formWith(4);
		const panel = filterPanel({ form });
		expect(panel).toEqual({ type: "accordion", label: "Filters", blocks: [form] });
		// Closed is the default and is expressed by OMITTING default_open (em-dash
		// defaults it to false), so the payload stays minimal.
		expect("default_open" in panel).toBe(false);
	});

	test("the collapsed label carries the ACTIVE filter, so a closed panel still says what you are looking at", () => {
		const panel = filterPanel({
			form: formWith(4),
			summary: ["status: paid", "last 30 days"],
		});
		expect((panel as AccordionBlock).label).toBe("Filters — status: paid, last 30 days");
	});

	test("summary composition drops falsy entries so call sites can inline conditionals", () => {
		expect(filterPanelLabel("Filters", [])).toBe("Filters");
		expect(filterPanelLabel("Filters", undefined)).toBe("Filters");
		expect(filterPanelLabel("Filters", ["", undefined, null, false])).toBe("Filters");
		expect(filterPanelLabel("Zone filter", [false, "zone: us", undefined, "shipping: yes"])).toBe(
			"Zone filter — zone: us, shipping: yes",
		);
	});

	test("label, inlineUpTo, defaultOpen and blockId are all honoured", () => {
		const form = formWith(1);
		// inlineUpTo: 0 forces the accordion even for a single field.
		const panel = filterPanel({
			form,
			label: "Rate filter",
			summary: ["zone: us"],
			inlineUpTo: 0,
			defaultOpen: true,
			blockId: "tax-rates-filter",
		});
		expect(panel).toEqual({
			type: "accordion",
			label: "Rate filter — zone: us",
			blocks: [form],
			default_open: true,
			block_id: "tax-rates-filter",
		});
	});

	test("the form's own block_id (its carrier) is left alone — the accordion keeps its own", () => {
		const form: FormBlock = {
			...formWith(3),
			block_id: encodeCarrier({ [PATH_FIELD]: encodePath(["z1"]) }),
		};
		const panel = filterPanel({ form, blockId: "outer" }) as AccordionBlock;
		expect(panel.block_id).toBe("outer");
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
				commandLine: "pnpm seed",
				size: "sm",
				actions,
				blockId: "products-empty",
			}),
		).toEqual({
			type: "empty",
			title: "No products",
			description: "Publish one to see it here.",
			command_line: "pnpm seed",
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
