/**
 * The `OrderStore` contract slices against `EmdashOrderStore`, on **D1** — the
 * dialect Otta actually ships on, through the host's OWN Kysely wiring.
 *
 * Six suites run here, not just the store contract: they cost little and they exercise
 * the things only this tier can. `listExpirable` and the admin LIST are real indexed
 * `query()` calls with the host's limit clamp and cursor, against the `json_extract`
 * expressions D1 has to plan — the list reaches four declared fields (`state`,
 * `createdAt`, `customerKey`/`buyerRefLower`, `searchKey`) plus a second collection for
 * the by-sku arm, which is the widest indexed predicate this package issues anywhere.
 * And the order document is the largest this package writes, so D1's SQLite build is
 * where its serialization has to hold.
 *
 * The harness wiring is `test/order-harness.ts`. Every suite here is the DOMAIN's own,
 * run in full — `orderStoreContract` included, now that the contract guarantees the
 * ratified anchored PREFIX search this store serves rather than an unanchored
 * substring it cannot; the narrowed copy that stood in for it is gone. Nothing here
 * names a Node driver, so all of it loads inside `workerd`; only the storage BINDING
 * differs, and that is what `describe-d1.ts` supplies.
 */
import {
	buildRefundSeed,
	orderCancellationContract,
	orderFulfillmentContract,
	orderStoreContract,
	orderTimelineContract,
	orderTransitionContract,
	refundOrderContract,
} from "@otta-sh/domain/testing";
import { cancellationReleaseCase } from "../order-cancellation-release.js";
import { orderListCases } from "../order-list-cases.js";
import { ORDER_LAYOUT } from "../order-collections.js";
import {
	makeOrderHarness,
	orderStoreHarness,
	orderTimelineHarness,
	orderTransitionHarness,
} from "../order-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(ORDER_LAYOUT);

orderStoreContract(async () => orderStoreHarness(makeOrderHarness(bound.storage)), {
	dialect: "d1",
});
orderTransitionContract(
	async () => orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true })),
	{ dialect: "d1" },
);
orderTimelineContract(
	async () => orderTimelineHarness(makeOrderHarness(bound.storage, { countingIds: true })),
	{ dialect: "d1" },
);

refundOrderContract(
	() => {
		const orderStore = makeOrderHarness(bound.storage, { countingIds: true }).store;
		return { orderStore, seedPaidOrder: buildRefundSeed(orderStore) };
	},
	{ dialect: "d1" },
);
orderFulfillmentContract(
	async () => orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true })),
	{ dialect: "d1" },
);
orderCancellationContract(
	async () => orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true })),
	{ dialect: "d1" },
);
// The release bracket's sharp edge on D1 too — a full-harness case, shared with the
// Node dialect suite rather than restated (see `order-cancellation-release.ts`).
cancellationReleaseCase(() => makeOrderHarness(bound.storage));
// The document model's own list / search / customer-union / locator statements, on the
// dialect Otta ships on — where the list's indexed `query()` is planned by D1's SQLite
// build rather than by better-sqlite3 or pg.
orderListCases(() => bound.storage);
