/**
 * `/checkout/pay`'s entry guard — the page must refuse to mount a card form for an
 * order that can no longer take the money.
 *
 * The bug it closes: the pay page used to render from the `otta_checkout` cookie
 * alone, so a buyer who kept it open (or came back to it) after the hold lapsed
 * could pay an order whose stock had already gone back on sale. Stripe captured,
 * the order stayed expired, and the order page said "Nothing was charged".
 */
import type { OrderRouteResult, PublicOrderView } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";
import { isOrderPayable, payPageRedirect } from "../src/lib/pay-guard.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ORDER_PATH = "/orders/ord-1";

function order(over: Partial<PublicOrderView> = {}): PublicOrderView {
	return {
		id: "ord-1",
		state: "pending",
		currency: "USD",
		paymentMethod: "stripe",
		holdExpiresAt: "2026-10-02T12:05:00.000Z",
		createdAt: "2026-10-02T11:50:00.000Z",
		totals: {} as PublicOrderView["totals"],
		lines: [],
		fulfillment: null,
		cancellation: null,
		latePayment: "none",
		...over,
	};
}

const ok = (o: PublicOrderView): OrderRouteResult => ({ ok: true, order: o });

describe("isOrderPayable", () => {
	test("a pending order inside its hold is payable", () => {
		expect(isOrderPayable(order(), NOW)).toBe(true);
	});

	test("a pending order AT or past its hold deadline is not — the sweep just has not run yet", () => {
		expect(isOrderPayable(order({ holdExpiresAt: NOW.toISOString() }), NOW)).toBe(false);
		expect(isOrderPayable(order({ holdExpiresAt: "2026-10-02T11:59:59.000Z" }), NOW)).toBe(false);
	});

	test("any state but pending is not payable", () => {
		for (const state of ["expired", "cancelled", "failed", "paid", "refunded", "shipped"]) {
			expect(isOrderPayable(order({ state }), NOW), state).toBe(false);
		}
	});

	test("an unreadable deadline is not payable — never mount a card form on a guess", () => {
		expect(isOrderPayable(order({ holdExpiresAt: "not-a-date" }), NOW)).toBe(false);
	});
});

describe("payPageRedirect", () => {
	test("a payable order renders the form (null)", () => {
		expect(payPageRedirect(ORDER_PATH, ok(order()), NOW)).toBeNull();
	});

	test("an expired, cancelled or already-paid order goes to its own page, which states the truth", () => {
		for (const state of ["expired", "cancelled", "paid"]) {
			expect(payPageRedirect(ORDER_PATH, ok(order({ state })), NOW), state).toBe(ORDER_PATH);
		}
	});

	test("a pending order whose hold lapsed goes to its page too", () => {
		const lapsed = order({ holdExpiresAt: "2026-10-02T11:00:00.000Z" });
		expect(payPageRedirect(ORDER_PATH, ok(lapsed), NOW)).toBe(ORDER_PATH);
	});

	test("an order the read says does not exist goes to its page (the 404 is told there)", () => {
		expect(payPageRedirect(ORDER_PATH, { ok: false, reason: "ORDER_NOT_FOUND" }, NOW)).toBe(
			ORDER_PATH,
		);
	});

	test("an UNKNOWN answer (dispatch failed, busy, render failure) renders the form — the late-payment refund is the backstop", () => {
		// Refusing on a read we could not make would turn a storage hiccup into a
		// checkout outage. The server-side guarantees do not depend on this page:
		// expiry cancels the intent, and a payment that lands anyway is refunded.
		expect(payPageRedirect(ORDER_PATH, null, NOW)).toBeNull();
		expect(
			payPageRedirect(ORDER_PATH, { ok: false, error: "BUSY" } as unknown as OrderRouteResult, NOW),
		).toBeNull();
		expect(
			payPageRedirect(
				ORDER_PATH,
				{ ok: false, error: "RENDER_FAILED" } as unknown as OrderRouteResult,
				NOW,
			),
		).toBeNull();
	});
});
