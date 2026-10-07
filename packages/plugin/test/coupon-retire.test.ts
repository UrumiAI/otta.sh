/**
 * `retireCoupon` — the cases that need more than the contract can express. The
 * core behaviour (injected clock, future start dropped, already_ended, not_found)
 * is in `contracts/commerce-client-contract.ts`; these two need a pinned instant
 * (millisecond string ordering) and a storage proxy (the LWW window).
 *
 * In-process over a real document store (no mocks): the subject is the client's
 * read-then-write, the instant it stamps and the window it documents, none of
 * which needs the sandbox.
 */
import { cents, currency, type Clock } from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import type { PluginContext, StorageAccess } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const NOW = new Date("2026-10-02T12:00:00.500Z");
const clock: Clock = { now: () => new Date(NOW) };

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	harness = await makeInProcessCommerce({ clock });
});
afterEach(async () => {
	await harness.close();
});

function rules(ctx: PluginContext = harness.ctx): InProcessAdminRulesClient {
	return new InProcessAdminRulesClient(ctx, { clock });
}

async function seed(over: { startsAt?: string | null; expiresAt?: string | null } = {}) {
	await harness.stores.couponStore.create({
		id: "c-live",
		code: "LIVE10",
		type: "fixed_amount",
		amountCents: cents(1000),
		rateBps: null,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: cents(2000),
		startsAt: over.startsAt ?? null,
		expiresAt: over.expiresAt ?? null,
		maxUses: 50,
		maxUsesPerCustomer: 2,
	});
}

describe("retireCoupon", () => {
	test("compares INSTANTS, not strings: a start 500 ms in the past without millis is kept", async () => {
		// As strings, "…12:00:00Z" sorts AFTER "…12:00:00.500Z" ('Z' > '.') and would
		// read as a future start to be dropped.
		await seed({ startsAt: "2026-10-02T12:00:00Z" });
		await rules().retireCoupon("c-live");
		expect((await harness.stores.couponStore.findById("c-live"))?.startsAt).toBe(
			"2026-10-02T12:00:00Z",
		);
	});

	test("reads bounds as checkout does (parseCouponInstant): an impossible date is unreadable, not rolled over (issue #364)", async () => {
		// `Date.parse` rolls 2026-09-31 over to 1 October — the past — and used to
		// answer "already ended" for a coupon checkout never read as ended (it fails
		// closed on an unreadable bound). Retire now replaces the unreadable expiry
		// with a real instant, which is what the operator asked for.
		await seed({ expiresAt: "2026-09-31T00:00:00Z" });
		const res = await rules().retireCoupon("c-live");
		expect(res.ok).toBe(true);
		expect((await harness.stores.couponStore.findById("c-live"))?.expiresAt).toBe(
			NOW.toISOString(),
		);
	});

	test("an unreadable START is kept as stored, even one Date.parse would roll into the future", async () => {
		// 2026-11-31 rolls to 1 December under Date.parse — a future start retire would
		// have dropped. Unreadable is not "in the future": retire changes only the
		// bound it must.
		await seed({ startsAt: "2026-11-31T00:00:00Z" });
		await rules().retireCoupon("c-live");
		expect((await harness.stores.couponStore.findById("c-live"))?.startsAt).toBe(
			"2026-11-31T00:00:00Z",
		);
	});

	test("THE DOCUMENTED WINDOW: an edit landing between retire's read and its write is overwritten (last writer wins)", async () => {
		// `CouponStore.update` is a last-writer-wins full replace (its doc). Retire
		// re-reads first, which narrows — never closes — the gap: an edit that lands
		// inside it loses its economics to the values retire read. Pinned so a
		// future CAS on coupons changes this test on purpose, not by accident.
		await seed();
		const raw = harness.ctx.storage as StorageAccess;
		let interleaved = false;
		const storage = new Proxy(raw, {
			get(target, name, receiver) {
				const collection = Reflect.get(target, name, receiver) as unknown;
				if (name !== "coupons" || typeof collection !== "object" || collection === null) {
					return collection;
				}
				return new Proxy(collection, {
					get(inner, method, innerReceiver) {
						const value = Reflect.get(inner, method, innerReceiver) as unknown;
						if (method !== "compareAndSet" || typeof value !== "function") {
							return typeof value === "function" ? value.bind(inner) : value;
						}
						return async (...args: unknown[]) => {
							if (!interleaved) {
								interleaved = true;
								await harness.stores.couponStore.update("c-live", {
									amountCents: cents(1500),
									rateBps: null,
									capCents: null,
									minSubtotalCents: cents(2000),
									startsAt: null,
									expiresAt: null,
									maxUses: 50,
									maxUsesPerCustomer: 2,
								});
							}
							return (value as (...a: unknown[]) => unknown).apply(inner, args);
						};
					},
				});
			},
		});
		const result = await rules({ ...harness.ctx, storage }).retireCoupon("c-live");
		expect(interleaved).toBe(true);
		expect(result.ok).toBe(true);
		const after = await harness.stores.couponStore.findById("c-live");
		expect(after?.expiresAt).toBe(NOW.toISOString());
		expect(after?.amountCents).toBe(1000); // the concurrent $15 edit is lost
	});
});
