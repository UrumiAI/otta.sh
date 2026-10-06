import { describe, expect, test } from "vitest";
import { idempotencyKey, orderId, productId, sku } from "../money/ids.js";
import type { EntitlementStore, GrantEntitlementInput } from "../ports/entitlement-store.js";

export interface EntitlementStoreHarness {
	store: EntitlementStore;
}

export interface EntitlementStoreContractOptions {
	dialect: string;
}

function grantInput(overrides: Partial<GrantEntitlementInput> = {}): GrantEntitlementInput {
	return {
		orderId: orderId("ord-1"),
		productId: productId("p1"),
		sku: sku("DIG-1"),
		buyerRef: "buyer@example.com",
		source: "order_paid",
		grantIdempotencyKey: idempotencyKey("grant-1"),
		...overrides,
	};
}

/**
 * The reusable `EntitlementStore` behavioral spec (§7): grant-once, check
 * active/absent (by order and by buyer), and revoke-by-order (the full-refund
 * revocation, issue #376).
 */
export function entitlementStoreContract(
	makeHarness: () => Promise<EntitlementStoreHarness>,
	opts: EntitlementStoreContractOptions,
): void {
	describe(`entitlementStoreContract [${opts.dialect}]`, () => {
		test("grant returns an active entitlement; check by order+sku returns true", async () => {
			const { store } = await makeHarness();
			const e = await store.grant(grantInput());
			expect(e.state).toBe("active");
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(true);
		});

		test("check by buyerRef+sku returns true; a different sku returns false", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput());
			expect(await store.check({ buyerRef: "buyer@example.com", sku: sku("DIG-1") })).toBe(true);
			expect(await store.check({ buyerRef: "buyer@example.com", sku: sku("OTHER") })).toBe(false);
		});

		// buyer_ref carries EMAIL semantics (the port doc + every fixture): a
		// case-distinct ref is the SAME principal, so check folds case like
		// OrderStore.linkGuestOrders — the session scope derives a lower-normalized
		// Email from the session and must hit an entitlement granted from a
		// mixed-case checkout buyer_ref. Folding is many-to-one, NOT injective —
		// see ADR-0011's case-folding section for why a folding collision on a
		// non-email ref is bounded to the operator/session scopes rather than
		// eliminated. ASCII-cased fixture: SQLite lower() folds ASCII only vs JS
		// toLowerCase full Unicode — the same accepted (fail-closed) divergence as
		// linkGuestOrders.
		test("check by buyerRef is case-insensitive (email semantics)", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput({ buyerRef: "Buyer@Example.COM" }));
			expect(await store.check({ buyerRef: "buyer@example.com", sku: sku("DIG-1") })).toBe(true);
			expect(await store.check({ buyerRef: "BUYER@EXAMPLE.COM", sku: sku("DIG-1") })).toBe(true);
		});

		test("grant is idempotent under grantIdempotencyKey — a replay grants once", async () => {
			const { store } = await makeHarness();
			const first = await store.grant(grantInput());
			const replay = await store.grant(grantInput());
			expect(replay.id).toBe(first.id);
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(true);
		});

		test("check returns false with no matching entitlement", async () => {
			const { store } = await makeHarness();
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(false);
		});

		test("a revoked entitlement is not returned by check", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput());
			await store.revokeByOrder(orderId("ord-1"));
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(false);
		});

		// -- revokeByOrder: the full-refund revocation (issue #376) --------------

		test("revokeByOrder revokes EVERY entitlement the order granted, on both scopes", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput());
			await store.grant(
				grantInput({ sku: sku("DIG-2"), grantIdempotencyKey: idempotencyKey("grant-2") }),
			);

			expect(await store.revokeByOrder(orderId("ord-1"))).toBe(2);

			for (const s of ["DIG-1", "DIG-2"]) {
				expect(await store.check({ orderId: orderId("ord-1"), sku: sku(s) })).toBe(false);
				// The buyer scope is refused too: no other order covers this buyer.
				expect(await store.check({ buyerRef: "buyer@example.com", sku: sku(s) })).toBe(false);
				expect(
					await store.check({
						orderId: orderId("ord-1"),
						buyerRef: "buyer@example.com",
						sku: sku(s),
					}),
				).toBe(false);
			}
		});

		test("revokeByOrder is idempotent: a replay revokes nothing more and still refuses", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput());
			expect(await store.revokeByOrder(orderId("ord-1"))).toBe(1);
			expect(await store.revokeByOrder(orderId("ord-1"))).toBe(0);
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(false);
		});

		test("revokeByOrder on an order that granted nothing is a no-op", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput());
			expect(await store.revokeByOrder(orderId("ord-none"))).toBe(0);
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(true);
		});

		test("revokeByOrder leaves every other order's entitlements untouched — same buyer, same sku", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput());
			await store.grant(
				grantInput({
					orderId: orderId("ord-2"),
					grantIdempotencyKey: idempotencyKey("grant-ord2"),
				}),
			);
			// Another buyer's order on the same sku, too.
			await store.grant(
				grantInput({
					orderId: orderId("ord-3"),
					buyerRef: "other@example.com",
					grantIdempotencyKey: idempotencyKey("grant-ord3"),
				}),
			);

			await store.revokeByOrder(orderId("ord-1"));

			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(false);
			expect(await store.check({ orderId: orderId("ord-2"), sku: sku("DIG-1") })).toBe(true);
			expect(await store.check({ orderId: orderId("ord-3"), sku: sku("DIG-1") })).toBe(true);
			// The buyer still owns the sku through the order that was NOT refunded.
			expect(await store.check({ buyerRef: "buyer@example.com", sku: sku("DIG-1") })).toBe(true);
			expect(await store.check({ buyerRef: "other@example.com", sku: sku("DIG-1") })).toBe(true);
		});

		// A settlement redelivered after the refund (a late Stripe webhook retry, or a
		// crash-heal re-drive) replays the grant under the SAME grant key. Grant-once
		// returns the RECORDED grant, so the replay must hand back the revoked one —
		// never re-open access the refund closed.
		test("a grant replayed after revokeByOrder does not resurrect the entitlement", async () => {
			const { store } = await makeHarness();
			await store.grant(grantInput());
			await store.revokeByOrder(orderId("ord-1"));

			const replay = await store.grant(grantInput());

			expect(replay.state).toBe("revoked");
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(false);
			expect(await store.check({ buyerRef: "buyer@example.com", sku: sku("DIG-1") })).toBe(false);
		});
	});
}
