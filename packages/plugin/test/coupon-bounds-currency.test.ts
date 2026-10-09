/**
 * A percentage coupon's bounds currency at the RULES CLIENT — the boundary that
 * must answer like the Block Kit screen whoever calls it. In-process over a real
 * document store (no mocks), as `coupon-retire.test.ts` is.
 */
import { cents, currency, type Clock } from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import type { PluginContext, StorageAccess } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const clock: Clock = { now: () => new Date("2026-10-08T12:00:00.000Z") };

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

/** `ctx` whose coupon writes run `before` once, just ahead of the FIRST
 *  compare-and-set — a concurrent write landing between the client's read and
 *  its write. */
function interleavedCtx(before: () => Promise<void>): { ctx: PluginContext; ran: () => boolean } {
	const raw = harness.ctx.storage as StorageAccess;
	let ran = false;
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
						if (!ran) {
							ran = true;
							await before();
						}
						return (value as (...a: unknown[]) => unknown).apply(inner, args);
					};
				},
			});
		},
	});
	return { ctx: { ...harness.ctx, storage }, ran: () => ran };
}

/** An unbound percentage coupon, optionally with a cap written before bounds
 *  carried a currency (a LEGACY bound, in hundredths). */
async function seed(capCents: number | null): Promise<void> {
	await harness.stores.couponStore.create({
		id: "c-pct",
		code: "TENOFF",
		type: "percentage",
		amountCents: null,
		rateBps: 1000,
		capCents: capCents === null ? null : cents(capCents),
		currency: null,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: null,
		maxUsesPerCustomer: null,
	});
}

const stored = () => harness.stores.couponStore.findById("c-pct");

describe("updateCoupon — the currency an edit's amounts were parsed in", () => {
	test("binds an unbound coupon WITH a new cap; an edit parsed as unbound after that is refused (409), nothing written", async () => {
		await seed(null);
		expect(
			(await rules().updateCoupon("c-pct", { rateBps: 1000, capCents: 500, currency: "JPY" })).ok,
		).toBe(true);
		expect(await stored()).toMatchObject({ capCents: 500, currency: "JPY" });
		// Another admin's form was read before the bind: its amounts were parsed
		// in hundredths, so they must not land on a JPY coupon.
		expect(
			await rules().updateCoupon("c-pct", { rateBps: 1000, capCents: 9000, currency: null }),
		).toEqual({ ok: false, reason: "error", status: 409 });
		expect((await stored())?.capCents).toBe(500);
		// A different currency is refused the same way; the same one saves.
		expect(
			await rules().updateCoupon("c-pct", { rateBps: 1000, capCents: 9000, currency: "EUR" }),
		).toEqual({ ok: false, reason: "error", status: 409 });
		expect(
			(await rules().updateCoupon("c-pct", { rateBps: 1000, capCents: 600, currency: "JPY" })).ok,
		).toBe(true);
	});

	test("RACE: a bind landing between the client's read and its write refuses the write (409) — the check runs inside the store's CAS", async () => {
		await seed(null);
		// A read the coupon UNBOUND and binds EUR with a €5.00 cap (500 cents).
		// Just before A's write, B binds JPY with a ¥300 cap.
		const { ctx, ran } = interleavedCtx(async () => {
			const bound = await harness.stores.couponStore.update("c-pct", {
				bindCurrency: currency("JPY"),
				expectCurrency: null,
				amountCents: null,
				rateBps: 1000,
				capCents: cents(300),
				minSubtotalCents: null,
				startsAt: null,
				expiresAt: null,
				maxUses: null,
				maxUsesPerCustomer: null,
			});
			expect(bound.ok).toBe(true);
		});
		expect(
			await rules(ctx).updateCoupon("c-pct", { rateBps: 1000, capCents: 500, currency: "EUR" }),
		).toEqual({ ok: false, reason: "error", status: 409 });
		expect(ran()).toBe(true);
		// A's 500 never landed on the JPY coupon (it would have meant ¥500): the
		// store's own precondition (expect unbound) refused it inside the CAS.
		expect(await stored()).toMatchObject({ capCents: 300, currency: "JPY" });
	});

	test("refuses to bind a currency to a coupon whose cap predates currencies (it would re-read it)", async () => {
		await seed(5000);
		await expect(
			rules().updateCoupon("c-pct", { rateBps: 1000, capCents: 5000, currency: "JPY" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT", field: "currency" });
		expect((await stored())?.currency).toBeNull();
		// Unbound, it still edits in hundredths exactly as before.
		expect(
			(await rules().updateCoupon("c-pct", { rateBps: 1000, capCents: 2500, currency: null })).ok,
		).toBe(true);
		expect((await stored())?.capCents).toBe(2500);
	});

	test("refuses a currency with no cap or minimum (it would restrict the coupon for nothing)", async () => {
		await seed(null);
		await expect(
			rules().updateCoupon("c-pct", { rateBps: 1000, capCents: null, currency: "EUR" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT", field: "currency" });
		expect((await stored())?.currency).toBeNull();
	});
});

describe("createCoupon — a percentage coupon's currency goes with its bounds", () => {
	const base = { id: "c-new", code: "NEW10", type: "percentage", rateBps: 1000 };

	test("a cap needs a currency; a currency needs a cap or minimum", async () => {
		await expect(rules().createCoupon({ ...base, capCents: 500 })).rejects.toMatchObject({
			code: "INVALID_INPUT",
			field: "currency",
		});
		await expect(rules().createCoupon({ ...base, currency: "EUR" })).rejects.toMatchObject({
			code: "INVALID_INPUT",
			field: "currency",
		});
		expect((await rules().createCoupon({ ...base, capCents: 500, currency: "JPY" })).ok).toBe(true);
		expect((await rules().createCoupon({ ...base, id: "c-plain", code: "PLAIN" })).ok).toBe(true);
	});
});

describe("the rules client is the single source of the bounds-currency rules", () => {
	test("a NEW cap on an unbound coupon without a currency throws the same typed refusal as create", async () => {
		await seed(null);
		await expect(
			rules().updateCoupon("c-pct", { rateBps: 1000, capCents: 500, currency: null }),
		).rejects.toMatchObject({
			code: "INVALID_INPUT",
			field: "currency",
			reason: "is required on a percentage coupon with a cap or minimum spend",
		});
		expect((await stored())?.capCents).toBeNull();
	});

	test("a MINIMUM alone is enough to carry a currency, on create and on edit alike", async () => {
		const created = await rules().createCoupon({
			id: "c-min",
			code: "MIN10",
			type: "percentage",
			rateBps: 1000,
			minSubtotalCents: 3000,
			currency: "JPY",
		});
		expect(created.ok).toBe(true);
		await seed(null);
		expect(
			(
				await rules().updateCoupon("c-pct", {
					rateBps: 1000,
					minSubtotalCents: 3000,
					currency: "JPY",
				})
			).ok,
		).toBe(true);
		expect(await stored()).toMatchObject({ minSubtotalCents: 3000, currency: "JPY" });
	});
});

describe("retireCoupon never leaves a bound coupon without its bounds", () => {
	test("RACE: a bind (with its cap) landing between retire's read and write is kept — retire re-reads and retires the bound coupon", async () => {
		await seed(null);
		const { ctx, ran } = interleavedCtx(async () => {
			const bound = await harness.stores.couponStore.update("c-pct", {
				bindCurrency: currency("JPY"),
				expectCurrency: null,
				amountCents: null,
				rateBps: 1000,
				capCents: cents(300),
				minSubtotalCents: null,
				startsAt: null,
				expiresAt: null,
				maxUses: null,
				maxUsesPerCustomer: null,
			});
			expect(bound.ok).toBe(true);
		});
		const retired = await rules(ctx).retireCoupon("c-pct");
		expect(ran()).toBe(true);
		expect(retired.ok).toBe(true);
		// Without the precondition retire would have written cap null onto the JPY
		// coupon: bound, with nothing in that currency.
		expect(await stored()).toMatchObject({
			currency: "JPY",
			capCents: 300,
			expiresAt: clock.now().toISOString(),
		});
	});
});
