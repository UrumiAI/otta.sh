/**
 * ADR-0044 in the console's words: the two cash-on-delivery states, the Mark
 * paid buttons and their confirm, the payment badge and the "awaiting payment"
 * filter. Every branch is on the order's `settlement`, never on `=== "cod"`.
 */
import { describe, expect, test } from "vitest";
import {
	ORDER_STATES,
	ORDER_STATE_SET,
	TERMINAL_ORDER_STATES,
	autoCancelNote,
	formatDate,
	isOfflineMarkPaid,
	markPaidConfirm,
	PENDING_CANCEL_EFFECTS,
	SHIPPED_UNPAID_CANCEL_EFFECTS,
	cancelBannerText,
	cancelConfirmText,
	cancelGroupLabel,
	offlinePaymentBadge,
	orderStateCell,
	orderStatusFilterLabel,
	refundCapabilityText,
	transitionButtonLabel,
	UNPAID_ORDER_STATES,
} from "../src/index.js";

describe("the two cash-on-delivery states", () => {
	test("are declared states, so the console offers their transitions and filters by them", () => {
		expect(ORDER_STATES).toContain("awaiting_payment");
		expect(ORDER_STATES).toContain("shipped_awaiting_payment");
		expect(ORDER_STATE_SET.has("shipped_awaiting_payment")).toBe(true);
		// Neither is a dead end: both can still be paid or cancelled.
		expect(TERMINAL_ORDER_STATES.has("awaiting_payment")).toBe(false);
		expect(TERMINAL_ORDER_STATES.has("shipped_awaiting_payment")).toBe(false);
	});

	test("read as words, never as a snake_case token", () => {
		expect(orderStateCell("awaiting_payment")).toBe("awaiting payment");
		expect(orderStateCell("shipped_awaiting_payment")).toBe("shipped, awaiting payment");
	});

	test("are unpaid — with pending, the states a cancel refunds nothing from", () => {
		expect([...UNPAID_ORDER_STATES].toSorted()).toEqual([
			"awaiting_payment",
			"pending",
			"shipped_awaiting_payment",
		]);
	});

	test("the Status filter names the COD state for what it is", () => {
		expect(orderStatusFilterLabel("awaiting_payment")).toBe("awaiting payment (COD)");
		expect(orderStatusFilterLabel("shipped_awaiting_payment")).toBe(
			"shipped, awaiting payment (COD)",
		);
		expect(orderStatusFilterLabel("paid")).toBe("paid");
		expect(orderStatusFilterLabel("cancelled")).toBe("cancelled");
	});
});

describe("the transition buttons", () => {
	const offline = { fromState: "awaiting_payment", settlement: "offline" } as const;

	test("→ paid on an offline order is Mark paid", () => {
		expect(transitionButtonLabel("paid", offline)).toBe("Mark paid");
		expect(isOfflineMarkPaid("paid", offline)).toBe(true);
	});

	test("shipped_awaiting_payment → delivered is Mark paid (delivered)", () => {
		const shipped = { fromState: "shipped_awaiting_payment", settlement: "offline" } as const;
		expect(transitionButtonLabel("delivered", shipped)).toBe("Mark paid (delivered)");
		expect(isOfflineMarkPaid("delivered", shipped)).toBe(true);
	});

	test("→ shipped_awaiting_payment is Mark shipped (unpaid)", () => {
		expect(transitionButtonLabel("shipped_awaiting_payment", offline)).toBe(
			"Mark shipped (unpaid)",
		);
		expect(isOfflineMarkPaid("shipped_awaiting_payment", offline)).toBe(false);
	});

	test("a card order's buttons are unchanged, and a card 'delivered' is no Mark paid", () => {
		const card = { fromState: "shipped", settlement: "gateway" } as const;
		expect(transitionButtonLabel("delivered", card)).toBe("Mark delivered");
		expect(transitionButtonLabel("refunded", card)).toBe("Mark refunded");
		expect(isOfflineMarkPaid("delivered", card)).toBe(false);
		expect(isOfflineMarkPaid("paid", { fromState: "pending", settlement: null })).toBe(false);
	});

	test("an offline order stuck in pending (placement's crash window) is a Mark paid too (B-N9)", () => {
		// The server lets Mark paid finish a COD order whose placement crashed before
		// its flip to awaiting_payment; that records cash like any other, so it is
		// confirmed and named the same.
		const stuck = { fromState: "pending", settlement: "offline" } as const;
		expect(isOfflineMarkPaid("paid", stuck)).toBe(true);
		expect(transitionButtonLabel("paid", stuck)).toBe("Mark paid");
		// A pending CARD order's → paid stays an ordinary move (the server refuses it).
		expect(isOfflineMarkPaid("paid", { fromState: "pending", settlement: "gateway" })).toBe(false);
		// And no other move from pending is one.
		expect(isOfflineMarkPaid("cancelled", stuck)).toBe(false);
		expect(isOfflineMarkPaid("delivered", stuck)).toBe(false);
	});

	test("the Mark paid confirm states the cash and the email (review finding 5)", () => {
		const confirm = markPaidConfirm("₹1,250.00");
		expect(confirm.text).toBe(
			"Confirm you received ₹1,250.00 in cash. This records the payment and emails the buyer.",
		);
		expect(confirm.title.length).toBeGreaterThan(0);
		expect(confirm.confirm).toBe("Yes, mark paid");
		expect(confirm.deny.length).toBeGreaterThan(0);
	});
});

describe("the payment method on the list", () => {
	test("an offline order wears a badge naming its method; a card order none", () => {
		expect(offlinePaymentBadge({ settlement: "offline", paymentMethod: "cod" })).toBe(
			"Cash on delivery",
		);
		expect(offlinePaymentBadge({ settlement: "gateway", paymentMethod: "stripe" })).toBeNull();
		expect(offlinePaymentBadge({ settlement: null, paymentMethod: "cod" })).toBeNull();
		// An older server sends no settlement: no badge, never a guess from the name.
		expect(offlinePaymentBadge({ paymentMethod: "cod" })).toBeNull();
	});
});

describe("refundCapabilityText branches on settlement", () => {
	test("an offline order is record-only, returned by hand", () => {
		expect(refundCapabilityText(false, "cod", "offline")).toMatch(/cash on delivery.*RECORD-ONLY/i);
		// The method's NAME alone decides nothing.
		expect(refundCapabilityText(false, "cod", "gateway")).toMatch(/^Automatic refunds/);
	});
});

describe("cancelling a shipped, unpaid COD order (B-N5)", () => {
	// The parcel is out: a cancel puts its units back on sale AT ONCE, so the copy
	// says to cancel only once the parcel has come back. Copy only — no restock box.
	const effects = SHIPPED_UNPAID_CANCEL_EFFECTS;

	test("refunds nothing — it was never paid", () => {
		expect(effects.refund).toBeNull();
		expect(effects.refundAutomatic).toBe(true);
	});

	test("the banner says the items go back on sale at once, and when to cancel", () => {
		const banner = cancelBannerText(effects);
		expect(banner).toContain(
			"Cancelling returns the items to stock at once — do it when the parcel has come back.",
		);
		expect(banner).toContain("emails the buyer");
		expect(banner).toContain("cannot be undone");
		expect(banner).not.toContain("held stock");
		expect(banner).not.toContain("refund");
	});

	test("the group label and the confirm carry the same consequence", () => {
		expect(cancelGroupLabel(effects)).toBe("Cancel order — permanent, returns the items to stock");
		expect(cancelConfirmText("Other", effects)).toBe(
			"Cancel this order as “Other”? This is permanent — the items go back on sale at once, so do it only when the parcel has come back.",
		);
	});

	test("an awaiting-payment order keeps the pending copy (its stock is only held)", () => {
		expect(cancelBannerText(PENDING_CANCEL_EFFECTS)).toContain("releases the held stock");
	});
});

describe("the auto-cancel date on an unpaid COD order (B-N6)", () => {
	const now = new Date("2026-11-03T10:00:00.000Z");

	test("says how many days are left, the date, and that paying stops it", () => {
		const at = "2026-11-17T10:00:00.000Z";
		expect(autoCancelNote(at, now)).toBe(`Auto-cancels in 14 days (${formatDate(at)}) if not paid`);
	});

	test("rounds a part day up, and says 1 day in the singular", () => {
		expect(autoCancelNote("2026-11-04T09:00:00.000Z", now)).toMatch(/^Auto-cancels in 1 day \(/);
		expect(autoCancelNote("2026-11-05T09:00:00.000Z", now)).toMatch(/^Auto-cancels in 2 days \(/);
	});

	test("a date already passed: the next sweep cancels it", () => {
		const at = "2026-11-01T10:00:00.000Z";
		expect(autoCancelNote(at, now)).toBe(
			`Auto-cancels on the next sweep (due ${formatDate(at)}) if not paid`,
		);
	});

	test("no date (off, not COD, an older server, or unreadable): no note", () => {
		expect(autoCancelNote(null, now)).toBeNull();
		expect(autoCancelNote(undefined, now)).toBeNull();
		expect(autoCancelNote("not a date", now)).toBeNull();
	});
});
