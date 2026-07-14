import { describe, expect, test } from "vitest";
import { idempotencyKey, orderId, productId, sku } from "../money/ids.js";
import type { EntitlementStore, GrantEntitlementInput } from "../ports/entitlement-store.js";

export interface EntitlementStoreHarness {
	store: EntitlementStore;
	/** Revoke every entitlement for an order (the adapter's UPDATE / fake helper). */
	revoke(orderId: string): Promise<void>;
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
 * active/absent (by order and by buyer), and revoke.
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
		// mixed-case checkout buyer_ref. Non-email refs (hex wallet / opaque x402
		// tokens) lower injectively, so folding stays safe. ASCII-cased fixture:
		// SQLite lower() folds ASCII only vs JS toLowerCase full Unicode — the same
		// accepted divergence as linkGuestOrders.
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
			const { store, revoke } = await makeHarness();
			await store.grant(grantInput());
			await revoke("ord-1");
			expect(await store.check({ orderId: orderId("ord-1"), sku: sku("DIG-1") })).toBe(false);
		});
	});
}
