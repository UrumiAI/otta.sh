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
import { cents } from "@otta-sh/domain";
import { couponStoreContract } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import type { CouponDoc } from "../src/coupon-documents.js";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

describeEachDialect("EmdashCouponStore", (ctx) => {
	const bound = ctx.useStorage(COUPON_LAYOUT);
	couponStoreContract(async () => makeCouponHarness(bound.storage), { dialect: ctx.dialect });

	test(`a stored coupon document WITHOUT a currency key reads as unbound and stays editable [${ctx.dialect}]`, async () => {
		// An import, a seed or an older shape may omit the key. `undefined` must
		// read as `null`, or the edit precondition (expect unbound) would refuse
		// every edit of it, forever.
		const h = makeCouponHarness(bound.storage);
		await h.seedCoupon({
			id: "no-cur",
			code: "NOCUR",
			type: "percentage",
			rateBps: 1000,
			createdAt: "2026-10-08T00:00:00.000Z",
		});
		const seeded = await h.coupons.get("no-cur");
		if (seeded === null) throw new Error("seed missing");
		const { currency: _dropped, ...withoutKey } = seeded;
		await h.coupons.put("no-cur", withoutKey as CouponDoc);
		expect((await h.store.findById("no-cur"))?.currency).toBeNull();
		const res = await h.store.update("no-cur", {
			expectCurrency: null,
			amountCents: null,
			rateBps: 1500,
			capCents: null,
			minSubtotalCents: cents(0),
			startsAt: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		expect(res.ok).toBe(true);
		expect((await h.store.findById("no-cur"))?.rateBps).toBe(1500);
	});
});
