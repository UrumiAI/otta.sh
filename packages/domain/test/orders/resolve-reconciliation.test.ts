import { idempotencyKey, orderId, resolveReconciliation } from "@urumi/domain";
import { CountingIdGen, FixedClock, InMemoryOrderStore } from "@urumi/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";

// The resolveReconciliation use-case (admin-UX Increment 1): validation
// (non-empty reason/resolver, order-must-exist, order-must-be-flagged), the
// reconciliation-axis legality (flagged → resolved), and delegation to the
// store's guarded flag-clear. Pure orchestration over the in-memory fake.

const FLAGGED = orderId("ord-flagged");
const CLEAN = orderId("ord-clean");

function build() {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	orderStore.seedSummaryOrder({
		id: "ord-flagged",
		state: "paid",
		currency: "USD",
		buyerRef: "buyer@example.com",
		createdAt: "2026-07-10T00:00:00.000Z",
		totalCents: 1000,
		reconciliationFlag: "commit lost for reservation res-9",
	});
	orderStore.seedSummaryOrder({
		id: "ord-clean",
		state: "paid",
		currency: "USD",
		buyerRef: "buyer@example.com",
		createdAt: "2026-07-10T00:00:00.000Z",
		totalCents: 1000,
	});
	return { deps: { orderStore }, clock };
}

const valid = {
	outcome: "fulfilled" as const,
	reason: "re-sourced the stock",
	resolvedBy: "ops@shop.test",
	idempotencyKey: idempotencyKey("k1"),
};

describe("resolveReconciliation", () => {
	let ctx: ReturnType<typeof build>;
	beforeEach(() => {
		ctx = build();
	});

	test("resolves a flagged order: clears the flag, records the disposition, leaves state alone", async () => {
		const res = await resolveReconciliation(ctx.deps, { orderId: FLAGGED, ...valid });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.resolved).toBe(true);
		expect(res.order.reconciliationFlag).toBeNull();
		expect(res.order.state).toBe("paid"); // the resolve never moves the state
		expect(res.order.reconciliationResolution).toEqual({
			outcome: "fulfilled",
			reason: "re-sourced the stock",
			resolvedBy: "ops@shop.test",
			resolvedAt: "2026-07-10T00:00:00.000Z",
		});
	});

	test("trims reason + resolvedBy and persists the trimmed values", async () => {
		const res = await resolveReconciliation(ctx.deps, {
			orderId: FLAGGED,
			outcome: "refunded",
			reason: "  refunded via stripe  ",
			resolvedBy: "  alice  ",
			idempotencyKey: idempotencyKey("k1"),
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.reconciliationResolution?.reason).toBe("refunded via stripe");
		expect(res.order.reconciliationResolution?.resolvedBy).toBe("alice");
	});

	test("rejects an empty (or whitespace-only) reason", async () => {
		const res = await resolveReconciliation(ctx.deps, {
			orderId: FLAGGED,
			...valid,
			reason: "   ",
		});
		expect(res).toEqual({ ok: false, reason: "EMPTY_REASON" });
		// Nothing was written — the order is still flagged.
		expect((await ctx.deps.orderStore.getById(FLAGGED))?.reconciliationFlag).not.toBeNull();
	});

	test("rejects an empty resolvedBy", async () => {
		const res = await resolveReconciliation(ctx.deps, {
			orderId: FLAGGED,
			...valid,
			resolvedBy: "",
		});
		expect(res).toEqual({ ok: false, reason: "EMPTY_RESOLVER" });
	});

	test("rejects resolving a NEVER-flagged order (NOT_IN_RECONCILIATION)", async () => {
		const res = await resolveReconciliation(ctx.deps, { orderId: CLEAN, ...valid });
		expect(res).toEqual({ ok: false, reason: "NOT_IN_RECONCILIATION" });
		expect((await ctx.deps.orderStore.getById(CLEAN))?.reconciliationResolution).toBeNull();
	});

	test("rejects an unknown order (ORDER_NOT_FOUND)", async () => {
		const res = await resolveReconciliation(ctx.deps, { orderId: orderId("ghost"), ...valid });
		expect(res).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
	});

	test("replay is a benign no-op: an already-resolved order resolves:false and keeps the first disposition", async () => {
		const first = await resolveReconciliation(ctx.deps, { orderId: FLAGGED, ...valid });
		expect(first.ok && first.resolved).toBe(true);
		// A second call (different disposition) is a redelivery/double-click — not an
		// error, and it does NOT overwrite the recorded resolution.
		const replay = await resolveReconciliation(ctx.deps, {
			orderId: FLAGGED,
			outcome: "written_off",
			reason: "second call",
			resolvedBy: "bob",
			idempotencyKey: idempotencyKey("k2"),
		});
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.resolved).toBe(false);
		expect(replay.order.reconciliationResolution?.outcome).toBe("fulfilled");
		expect(replay.order.reconciliationResolution?.resolvedBy).toBe("ops@shop.test");
	});
});
