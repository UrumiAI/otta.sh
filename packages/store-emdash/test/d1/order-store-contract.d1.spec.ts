/**
 * The `OrderStore` contract slices against `EmdashOrderStore`, on **D1** — the
 * dialect Otta actually ships on, through the host's OWN Kysely wiring.
 *
 * All three staged slices run here, not just the store contract: they cost little
 * and they exercise the two things only this tier can. First, `listExpirable` is a
 * real indexed `query()` with the host's limit clamp and cursor, against the
 * `json_extract` expressions D1 has to plan — on TWO declared fields at once
 * (`state` and `holdExpiresAt`), which is the first place in this package a
 * multi-field indexed predicate is exercised. Second, the order document is the
 * largest this package writes, and D1's SQLite build is where its serialization has
 * to hold.
 *
 * The harness wiring is `test/order-harness.ts` and the staged slices are
 * `test/order-contract-b2.ts`, imported rather than restated — neither names a Node
 * driver, so both load inside `workerd`. Only the storage BINDING differs, and that
 * is what `describe-d1.ts` supplies, unchanged.
 */
import { ORDER_LAYOUT } from "../order-collections.js";
import {
	orderStoreContractB2,
	orderTimelineContractB2,
	orderTransitionContractB2,
} from "../order-contract-b2.js";
import {
	makeOrderHarness,
	orderStoreHarness,
	orderTimelineHarness,
	orderTransitionHarness,
} from "../order-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(ORDER_LAYOUT);

orderStoreContractB2(async () => orderStoreHarness(makeOrderHarness(bound.storage)), {
	dialect: "d1",
});
orderTransitionContractB2(
	async () => orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true })),
	{ dialect: "d1" },
);
orderTimelineContractB2(
	async () => orderTimelineHarness(makeOrderHarness(bound.storage, { countingIds: true })),
	{ dialect: "d1" },
);
