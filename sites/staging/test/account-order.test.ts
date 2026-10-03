/**
 * The account's order page offers what the public order page offers for the same
 * order (QA2 X1) — Complete payment for a payable pending order, the tracking once
 * shipped, the delivery address, and the order's own page — and the list tells
 * two orders of the same thing apart (QA2 A2): the time it was placed and a short
 * reference the store can search by.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { templateOf } from "./astro-source.js";
import { SRC, viewCases } from "./theme-views.js";
import {
	accountOrderExtras,
	orderPlacedAt,
	orderShortRef,
	trackingHref,
} from "../src/lib/account-order.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const ID = "621a6c23-0d1e-4c55-9d7e-2f1a3b4c5d6e";

function order(over: Record<string, unknown> = {}) {
	return {
		id: ID,
		state: "paid",
		holdExpiresAt: "2026-10-03T12:15:00.000Z",
		fulfillment: null,
		shippingAddress: null,
		...over,
	} as Parameters<typeof accountOrderExtras>[0];
}

describe("accountOrderExtras — the public order page's offers, on the account page", () => {
	test("a payable pending order offers Complete payment through the page-owned resume path", () => {
		const extras = accountOrderExtras(order({ state: "pending" }), NOW);
		expect(extras.payHref).toBe(`/checkout/resume?order=${encodeURIComponent(ID)}`);
	});

	test("a pending order past its hold, or any other state, offers no payment", () => {
		expect(
			accountOrderExtras(
				order({ state: "pending", holdExpiresAt: "2026-10-03T11:59:59.000Z" }),
				NOW,
			).payHref,
		).toBeNull();
		for (const state of ["paid", "shipped", "expired", "cancelled", "refunded"]) {
			expect(accountOrderExtras(order({ state }), NOW).payHref).toBeNull();
		}
	});

	test("always links the order's own page", () => {
		expect(accountOrderExtras(order(), NOW).orderPageHref).toBe(`/orders/${ID}`);
	});

	test("the tracking once shipped, with a link only for an http(s) address", () => {
		const shipped = accountOrderExtras(
			order({
				state: "shipped",
				fulfillment: {
					carrier: "Royal Mail",
					trackingNumber: "RM123",
					trackingUrl: "https://track.example/RM123",
					shippedAt: "2026-10-03T10:00:00.000Z",
				},
			}),
			NOW,
		);
		expect(shipped.tracking).toEqual({
			carrier: "Royal Mail",
			trackingNumber: "RM123",
			trackingUrl: "https://track.example/RM123",
		});
		expect(accountOrderExtras(order(), NOW).tracking).toBeNull();
	});

	test("the delivery address as lines, the country named", () => {
		const extras = accountOrderExtras(
			order({
				shippingAddress: {
					name: "Ada Lovelace",
					line1: "1 Analytical Way",
					line2: "Flat 2",
					city: "Austin",
					region: "TX",
					postalCode: "78701",
					country: "US",
				},
			}),
			NOW,
		);
		expect(extras.addressLines).toEqual([
			"Ada Lovelace",
			"1 Analytical Way",
			"Flat 2",
			"Austin TX 78701",
			"United States",
		]);
		expect(accountOrderExtras(order(), NOW).addressLines).toBeNull();
	});
});

describe("trackingHref — never a script or another scheme", () => {
	test.each([
		["https://track.example/x", "https://track.example/x"],
		["http://track.example/x", "http://track.example/x"],
		["javascript:alert(1)", null],
		["data:text/html,hi", null],
		["//evil.example", null],
		["not a url", null],
		[null, null],
	])("%p → %p", (raw, expected) => {
		expect(trackingHref(raw)).toBe(expected);
	});
});

describe("the list tells two orders apart (QA2 A2)", () => {
	test("the time it was placed, in UTC like every server-rendered time", () => {
		expect(orderPlacedAt("2026-10-02T14:05:09.000Z")).toEqual({
			text: "Oct 2, 2026, 14:05 UTC",
			iso: "2026-10-02T14:05:09.000Z",
		});
		expect(orderPlacedAt("garbage")).toBeNull();
	});

	test("a short reference — the start of the id, as the store's order search takes it", () => {
		expect(orderShortRef(ID)).toBe("621A6C23");
	});
});

describe.each(viewCases("accountOrder"))("the account order view %s", (_label, { source }) => {
	const template = templateOf(source);

	test("offers Complete payment and the order's own page from the model, never a path of its own", () => {
		expect(template).toMatch(/href=\{order\.payHref\}[^>]*>\s*Complete payment/);
		expect(template).toContain("href={order.orderPageHref}");
		expect(template).not.toMatch(/href=["'`]\/checkout\/resume/);
	});

	test("shows the tracking and the delivery address the page handed over", () => {
		expect(template).toContain("order.tracking.trackingNumber");
		expect(template).toContain("href={order.tracking.trackingUrl}");
		expect(template).toContain("order.addressLines.map(");
	});

	test("names the signed-in email", () => {
		expect(template).toContain("Signed in as {signedInAs}");
	});
});

describe.each(viewCases("accountOrders"))("the account orders view %s", (_label, { source }) => {
	const template = templateOf(source);

	test("each row carries the time and the short reference", () => {
		expect(template).toContain("{row.placed.text}");
		expect(template).toContain("{row.ref}");
	});

	test("names the signed-in email beside Sign out", () => {
		expect(template).toContain("Signed in as {signedInAs}");
	});

	test("the empty state's link is styled like the theme's other links", () => {
		expect(template).toMatch(/<a class="[^"]+" href="\/products">Browse products<\/a>/);
	});
});

describe("the account order pages", () => {
	const page = (file: string) => readFileSync(path.join(SRC, "pages/account/orders", file), "utf8");

	test("the order page builds the offers with accountOrderExtras and names the session's email", () => {
		const source = page("[id].astro");
		expect(source).toContain("...accountOrderExtras(order, now)");
		expect(source).toContain("signedInEmail(");
	});

	test("the list dates rows to the minute and gives each its reference", () => {
		const source = page("index.astro");
		expect(source).toContain("orderPlacedAt(order.createdAt)");
		expect(source).toContain("orderShortRef(order.id)");
		expect(source).toContain("signedInEmail(");
	});
});
