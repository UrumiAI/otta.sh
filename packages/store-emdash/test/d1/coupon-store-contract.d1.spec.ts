/**
 * The domain's `couponStoreContract` against `EmdashCouponStore`, on **D1** — the
 * dialect Otta actually ships on, through the host's OWN Kysely wiring.
 *
 * The contract runs in full, with no skips. What this tier exercises that the others
 * cannot is the READ contract and the guarded statement as D1's SQLite build plans
 * them: the admin list's `createdAt` range and ORDER BY, the redemption reads'
 * `couponId`/`orderId`/`redemptionId` equalities with the `holdsUse` text mirror
 * ANDed onto them, and — the reason this store has a D1 tier at all — the two
 * `updateIf` sites, whose `json_set` + `RETURNING` statement is the only write in
 * this package that is not a `compareAndSet`. A declared index is a read contract
 * rather than a performance knob, so this is where that contract is checked against
 * the runtime that will serve it.
 *
 * The harness wiring is `test/coupon-harness.ts`, imported rather than restated — it
 * names no Node driver, so it loads inside `workerd`. Only the storage BINDING
 * differs, and that is what `describe-d1.ts` supplies.
 */
import { couponStoreContract } from "@otta-sh/domain/testing";
import { COUPON_LAYOUT } from "../coupon-collections.js";
import { makeCouponHarness } from "../coupon-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(COUPON_LAYOUT);

couponStoreContract(async () => makeCouponHarness(bound.storage), { dialect: "d1" });
