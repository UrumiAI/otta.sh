/**
 * `isEmailAddress` — the shape check that decides whether a guest order's
 * `buyerRef` is an email recipient at all (ADR-0028 Decision 7), shared with
 * `email()`. Deliberately minimal (one `@`, something on both sides, after
 * trimming): it must never refuse an address a buyer could really have, because a
 * refusal means that order is never emailed. `orderHasEmailRecipient` is the pure
 * order-level answer built on it.
 */
import { describe, expect, test } from "vitest";
import { customerId, email, isEmailAddress } from "../src/money/ids.js";
import { orderHasEmailRecipient } from "../src/orders/transition.js";

const ACCEPTED: readonly [string, string][] = [
	["plain", "buyer@example.com"],
	["plus-addressing", "buyer+orders@example.com"],
	["IDN domain", "käufer@bücher.de"],
	["Unicode local part", "用户@例子.广告"],
	["uppercase", "Buyer@Example.COM"],
	["surrounding whitespace", "  buyer@example.com\t"],
	["subdomain and long TLD", "a.b@mail.shop.example.photography"],
];

const REFUSED: readonly [string, string][] = [
	["an x402 wallet reference", "x402:0x1111111111111111111111111111111111111111"],
	["no domain", "a@"],
	["no local part", "@b"],
	["two @", "a@b@c"],
	["no @ at all", "wallet-without-an-at-sign"],
	["empty", ""],
	["whitespace only", "   "],
];

describe("isEmailAddress", () => {
	for (const [name, value] of ACCEPTED) {
		test(`accepts ${name}: ${JSON.stringify(value)}`, () => {
			expect(isEmailAddress(value)).toBe(true);
			// `email()` applies the same rule: what it accepts, it brands.
			expect(() => email(value)).not.toThrow();
		});
	}
	for (const [name, value] of REFUSED) {
		test(`refuses ${name}: ${JSON.stringify(value)}`, () => {
			expect(isEmailAddress(value)).toBe(false);
			expect(() => email(value)).toThrow(RangeError);
		});
	}
});

describe("orderHasEmailRecipient", () => {
	test("a guest with an email buyerRef has one; a guest with an x402 ref has none", () => {
		expect(orderHasEmailRecipient({ customerId: null, buyerRef: "buyer@example.com" })).toBe(true);
		expect(
			orderHasEmailRecipient({
				customerId: null,
				buyerRef: "x402:0x1111111111111111111111111111111111111111",
			}),
		).toBe(false);
	});

	test("a linked customer has one whatever the buyerRef — the drain reads the customer's email", () => {
		expect(
			orderHasEmailRecipient({ customerId: customerId("cust-1"), buyerRef: "session:abc" }),
		).toBe(true);
	});
});
