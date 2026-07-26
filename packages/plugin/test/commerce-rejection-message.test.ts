import { describe, expect, test } from "vitest";
import {
	commerceRejectionMessage,
	MAX_SENTINEL_KEY_LENGTH,
	SENTINEL_PREFIX,
} from "../src/product-commerce/commerce-rejection-message.js";
import { commerceSaveBlockers } from "../src/product-commerce/commerce-save-blockers.js";

/** C0 + DEL + C1 control characters — none may survive into the key, which
 *  becomes an em-dash IDENTIFIER on the degraded non-revision write path. */
function hasControlChars(text: string): boolean {
	return [...text].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
	});
}

/**
 * The sentinel key IS the merchant-facing message (plan §4.3): em-dash's
 * `validateContentData` rejects any unknown top-level data key and the editor
 * toasts the resulting `VALIDATION_ERROR.message` verbatim. It is best-effort
 * UX — the load-bearing invariant is the STRIP (see the sandbox suite) — but
 * its hygiene is entirely ours, so it is pinned here, host-independently.
 */
describe("commerceRejectionMessage — the sentinel key", () => {
	test("quotes the offending value and states the required form", () => {
		const key = commerceRejectionMessage(commerceSaveBlockers({ price: 24.99 }));
		expect(key).toContain('"24.99"');
		expect(key).toContain("2499");
		expect(key).toContain("minor units");
	});

	test("truncates a long value to 40 chars and strips control characters and newlines", () => {
		const sku = `${"S".repeat(150)}\nX\t${"Y".repeat(150)}`;
		const key = commerceRejectionMessage(commerceSaveBlockers({ sku }));
		expect(hasControlChars(key)).toBe(false);
		const quoted = /"([^"]*)"/.exec(key)?.[1];
		expect(quoted).toBeDefined();
		expect((quoted ?? "").length).toBeLessThanOrEqual(40);
		expect(quoted).toMatch(/…$/);
	});

	test("caps the whole key below MAX_IDENTIFIER_LENGTH for every blocker combination", () => {
		// em-dash's `validateIdentifier` caps identifiers at 128.
		expect(MAX_SENTINEL_KEY_LENGTH).toBeLessThan(128);

		const worst = {
			price: -1.5,
			currency: "not-a-currency-code",
			sku: `${"S".repeat(400)}\n`,
			onHand: -99.5,
			productKind: "gaseous",
			taxClass: 7,
			weightGrams: -1.1,
			lengthMm: -1.1,
			widthMm: -1.1,
			heightMm: -1.1,
		};
		const blockers = commerceSaveBlockers(worst);
		expect(blockers).toHaveLength(10);

		// Every prefix of the worst case, plus every singleton — the shapes that
		// bound both the "one detailed clause" and the "also: …" label list.
		for (let n = 1; n <= blockers.length; n += 1) {
			const key = commerceRejectionMessage(blockers.slice(0, n));
			expect(key.length).toBeLessThanOrEqual(MAX_SENTINEL_KEY_LENGTH);
			expect(hasControlChars(key)).toBe(false);
			expect(key.startsWith(SENTINEL_PREFIX)).toBe(true);
		}
		for (const blocker of blockers) {
			const key = commerceRejectionMessage([blocker]);
			expect(key.length).toBeLessThanOrEqual(MAX_SENTINEL_KEY_LENGTH);
			expect(hasControlChars(key)).toBe(false);
		}
	});

	test("names every blocker once in a deterministic order and carries the scrub prefix", () => {
		const blockers = commerceSaveBlockers({ onHand: -1, currency: "usd", price: 24.99 });
		// Declaration order, independent of the bag's own key order.
		expect(blockers.map((b) => b.field)).toEqual(["price", "currency", "onHand"]);

		const key = commerceRejectionMessage(blockers);
		expect(key.startsWith(SENTINEL_PREFIX)).toBe(true);
		// Every blocker named, once, first-declared first.
		expect(key.split("Price")).toHaveLength(2);
		expect(key.split("Currency")).toHaveLength(2);
		expect(key.split("Stock")).toHaveLength(2);
		expect(key.indexOf("Price")).toBeLessThan(key.indexOf("Currency"));
		expect(key.indexOf("Currency")).toBeLessThan(key.indexOf("Stock"));
		// Byte-identical across calls — an unstable key would break the scrub's
		// "exactly one sentinel" guarantee.
		expect(commerceRejectionMessage(blockers)).toBe(key);
	});
});
