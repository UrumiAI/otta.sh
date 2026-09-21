/**
 * The domain's `couponStoreContract` against `EmdashCouponStore`, on every Node
 * dialect.
 *
 * The contract suite IS the spec: the same cases the fake and the SQL adapter run,
 * with no skips and no narrowing. What it exercises here that it cannot exercise on
 * the fake is that the redemption's guarantees survive being reassembled out of four
 * documents with no transaction between them — the per-key replay, the exhaustion
 * refusal, the per-customer cap, the guest degradation and the release floor all
 * have to give the answers they gave inside one transaction.
 */
import { couponStoreContract } from "@otta-sh/domain/testing";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

describeEachDialect("EmdashCouponStore", (ctx) => {
	const bound = ctx.useStorage(COUPON_LAYOUT);
	couponStoreContract(async () => makeCouponHarness(bound.storage), { dialect: ctx.dialect });
});
