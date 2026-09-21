/**
 * The read contract behind the delivery gate — this tier's port of the SQL package's
 * `entitlement-lookup-indices` suite.
 *
 * That suite pinned two composite indices at the DDL level and then EXPLAINed the
 * REAL compiled predicate to prove the index served it. Neither half transfers
 * literally: no physical index exists in any tier here (the dialect harness says so,
 * and no adapter may depend on one), so there is no plan to inspect. What DOES
 * transfer is the half that actually protects the gate — a declared index is a read
 * contract, and a `where` on a field the collection never declared raises
 * `StorageQueryError` instead of answering.
 *
 * So this suite does the same job from the other side. The positive half is
 * `misc-gate-cases.ts`, shared with the D1 spec because the tier that plans the query
 * is the tier worth checking it on, and it includes the operator shape that ANDs both
 * scopes — which no domain contract case covers. The negative half is here: the same
 * call over a layout with the `entitlements` indexes stripped must raise the typed
 * error rather than quietly fall back to anything. A declaration that stopped matching
 * the predicate would fail it, exactly as a rewritten fold stopped matching the
 * functional index in SQL.
 */
import { orderId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { isStorageQueryError } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { MISC_LAYOUT, MISC_LAYOUT_WITHOUT_ENTITLEMENT_INDEXES } from "./misc-collections.js";
import { entitlementGateCases, seedGrantedEntitlement } from "./misc-gate-cases.js";
import { makeMiscHarness } from "./misc-harness.js";

describeEachDialect("EmdashEntitlementStore", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT);
	entitlementGateCases(ctx.dialect, () => makeMiscHarness(bound.storage));
});

describeEachDialect("entitlement gate, indexes undeclared", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT_WITHOUT_ENTITLEMENT_INDEXES);

	test("with the indexes undeclared the gate raises StorageQueryError, never a wrong answer", async () => {
		const h = makeMiscHarness(bound.storage);
		await seedGrantedEntitlement(h);
		// The operator shape goes straight to the query — it has no pointer of its own —
		// so it is the shape that proves the declaration is load-bearing.
		const failure = await h.entitlementStore
			.check({
				orderId: orderId("ord-target"),
				buyerRef: "Mixed.Case.Buyer@Example.com",
				sku: sku("DIG-1"),
			})
			.then(
				() => undefined,
				(err: unknown) => err,
			);
		expect(isStorageQueryError(failure), `not a StorageQueryError: ${String(failure)}`).toBe(true);
	});
});
