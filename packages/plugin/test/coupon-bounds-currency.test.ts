/**
 * A percentage coupon's bounds currency at the RULES CLIENT — the boundary that
 * must answer like the Block Kit screen whoever calls it. In-process over a real
 * document store (no mocks), as `coupon-retire.test.ts` is.
 */
import { cents, type Clock } from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
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

function rules(): InProcessAdminRulesClient {
	return new InProcessAdminRulesClient(harness.ctx, { clock });
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
