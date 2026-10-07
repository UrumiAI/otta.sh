/**
 * The confirmation page's bounded poll (QA U-13).
 *
 * It used to count its hops in the URL (`?p=1…8`), so every hop was a NEW
 * history entry — eight Backs to leave the page — and it polled every pending
 * order, including one simply awaiting payment, where nothing is about to
 * change. Now:
 *  - it polls only when a change is expected: the buyer just came back from
 *    Stripe (`lib/order-poll.ts` says so; the page reads the redirect parameter
 *    for this and for the copy, never echoes it);
 *  - every hop reloads the SAME URL (`<meta http-equiv="refresh" content="4">`
 *    with no `url=`), which browsers handle as a replacement, not a new entry —
 *    so the count lives in a short-lived cookie instead of the URL.
 */
import { describe, expect, test } from "vitest";
import {
	MAX_ORDER_POLLS,
	ORDER_POLL_COOKIE_NAME,
	orderPollHop,
	orderPollKey,
	recordOrderPollHop,
	shouldPollOrder,
} from "../src/lib/order-poll.js";
import type { CookieSetOptions } from "../src/lib/checkout-cookie.js";
import { splitAstro } from "./astro-source.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function jar(initial?: string) {
	let value = initial;
	const sets: { name: string; value: string; options: CookieSetOptions }[] = [];
	return {
		sets,
		get: (name: string) =>
			name === ORDER_POLL_COOKIE_NAME && value !== undefined ? { value } : undefined,
		set(name: string, next: string, options: CookieSetOptions) {
			sets.push({ name, value: next, options });
			value = next;
		},
	};
}

describe("orderPollHop — which hop this render is", () => {
	test("first arrival is hop 1", () => {
		expect(orderPollHop(jar(), "ord-1")).toBe(1);
	});

	test("the next render of the SAME order is the next hop", () => {
		const cookies = jar();
		recordOrderPollHop(cookies, "ord-1", orderPollHop(cookies, "ord-1"));
		expect(orderPollHop(cookies, "ord-1")).toBe(2);
		recordOrderPollHop(cookies, "ord-1", 2);
		expect(orderPollHop(cookies, "ord-1")).toBe(3);
	});

	test("another order's count does not carry over", () => {
		const cookies = jar();
		recordOrderPollHop(cookies, "ord-1", 5);
		expect(orderPollHop(cookies, "ord-2")).toBe(1);
	});

	test.each(["", "garbage", "ord-1:", "ord-1:-3", "ord-1:1.5", "ord-1:99999999999"])(
		"a malformed cookie (%j) starts again at hop 1",
		(raw) => {
			expect(orderPollHop(jar(raw), "ord-1")).toBe(1);
		},
	);
});

describe("orderPollKey — a fresh return from Stripe gets its full polls", () => {
	test("the count is keyed on the order AND the payment it came back from", () => {
		const cookies = jar();
		const first = orderPollKey("ord-1", "pi_first");
		recordOrderPollHop(cookies, first, MAX_ORDER_POLLS);
		expect(orderPollHop(cookies, first)).toBe(MAX_ORDER_POLLS + 1);
		// A second return within the cookie's two minutes (another card, another
		// attempt) is a new payment: it starts again at hop 1.
		expect(orderPollHop(cookies, orderPollKey("ord-1", "pi_second"))).toBe(1);
	});

	test("the key carries no client secret — only the order id and the intent id", () => {
		expect(orderPollKey("ord-1", "pi_123")).toBe("ord-1/pi_123");
		expect(orderPollKey("ord-1", null)).toBe("ord-1");
	});
});

describe("recordOrderPollHop — the cookie", () => {
	test("is scoped to the order pages, HttpOnly, Lax (it rides Stripe's top-level redirect back) and short-lived", () => {
		const cookies = jar();
		recordOrderPollHop(cookies, "ord-1", 1);
		expect(cookies.sets).toEqual([
			{
				name: ORDER_POLL_COOKIE_NAME,
				value: "ord-1:1",
				options: {
					httpOnly: true,
					secure: true,
					sameSite: "lax",
					path: "/orders/",
					maxAge: 120,
				},
			},
		]);
	});
});

describe("shouldPollOrder — only while a change is expected, and only so many times", () => {
	test("a pending order the buyer just paid for polls, up to the bound", () => {
		expect(shouldPollOrder({ state: "pending", returnedFromStripe: true, hop: 1 })).toBe(true);
		expect(
			shouldPollOrder({ state: "pending", returnedFromStripe: true, hop: MAX_ORDER_POLLS }),
		).toBe(true);
		expect(
			shouldPollOrder({ state: "pending", returnedFromStripe: true, hop: MAX_ORDER_POLLS + 1 }),
		).toBe(false);
	});

	test("a pending order simply awaiting payment does not poll: nothing is about to change", () => {
		expect(shouldPollOrder({ state: "pending", returnedFromStripe: false, hop: 1 })).toBe(false);
	});

	test.each(["paid", "expired", "failed", "cancelled", null])(
		"a %s order does not poll, even straight back from Stripe",
		(state) => {
			expect(shouldPollOrder({ state, returnedFromStripe: true, hop: 1 })).toBe(false);
		},
	);
});

describe("shouldPollOrder — a late payment on a dead order polls until its refund is recorded (QA2 M3)", () => {
	const late = { returnedFromStripe: true, returnedPaid: true, hop: 1 } as const;

	test.each(["expired", "cancelled", "failed"])(
		"a %s order the buyer just PAID polls while the refund is not on the ledger yet",
		(state) => {
			expect(shouldPollOrder({ ...late, state, latePayment: "none" })).toBe(true);
			expect(shouldPollOrder({ ...late, state, latePayment: "refund_pending" })).toBe(true);
		},
	);

	test("it stops once the refund is recorded, and at the same bound as every poll", () => {
		expect(shouldPollOrder({ ...late, state: "expired", latePayment: "refunded" })).toBe(false);
		expect(
			shouldPollOrder({ ...late, state: "expired", latePayment: "none", hop: MAX_ORDER_POLLS + 1 }),
		).toBe(false);
	});

	test("without a successful return status it does not poll", () => {
		expect(
			shouldPollOrder({
				state: "expired",
				returnedFromStripe: true,
				returnedPaid: false,
				latePayment: "none",
				hop: 1,
			}),
		).toBe(false);
	});
});

describe("the order page polls without piling up history", () => {
	const PAGE = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../src/pages/orders/[orderId].astro",
	);
	const { frontmatter, body: template } = splitAstro(readFileSync(PAGE, "utf8"));

	test("the refresh reloads the SAME url — no `url=`, so no new history entry and no hop in the URL", () => {
		const meta = /<meta http-equiv="refresh"[^>]*>/.exec(template)?.[0] ?? "";
		expect(meta).not.toBe("");
		expect(meta).not.toMatch(/url=/i);
		expect(template + frontmatter).not.toMatch(/\?p=/);
	});

	test("the poll decision is shouldPollOrder's, and its count is the cookie's", () => {
		expect(frontmatter).toMatch(
			/orderPollKey\(order\.id, Astro\.url\.searchParams\.get\("payment_intent"\)\)/,
		);
		expect(frontmatter).toMatch(/shouldPollOrder\(/);
		expect(frontmatter).toMatch(/orderPollHop\(/);
		expect(frontmatter).toMatch(/recordOrderPollHop\(/);
	});

	test("QA2 M3: a successful return status is read for copy and polling only, and handed to both", () => {
		// succeeded or processing — the two statuses Stripe returns for money that
		// moved or is moving; a declined return keeps "Nothing was charged".
		expect(frontmatter).toMatch(/searchParams\.get\("redirect_status"\)/);
		expect(frontmatter).toMatch(
			/const returnedPaid =\s*returnedFromStripe && \(\w+ === "succeeded" \|\| \w+ === "processing"\);/,
		);
		const poll = /shouldPollOrder\(\{[\s\S]*?\}\)/.exec(frontmatter)?.[0] ?? "";
		expect(poll).toMatch(/returnedPaid/);
		expect(poll).toMatch(/latePayment/);
		const stamp = /orderStamp\(\{[\s\S]*?\}\)/.exec(frontmatter)?.[0] ?? "";
		expect(stamp).toMatch(/returnedPaid/);
		// …and whether it was only PROCESSING, which promises less.
		expect(stamp).toMatch(/returnedProcessing/);
		// The hop count runs for a dead order the buyer just paid, too.
		expect(frontmatter).not.toMatch(/isPending && returnedFromStripe \? orderPollHop/);
	});
});
