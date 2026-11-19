/**
 * The admin COUPON operations, called directly — no console action, no notice.
 *
 * These are the decisions `coupons-page.ts` used to make inline around each
 * rules-client write: which half of a create collided (the code lookup), which
 * rules-client refusals are the coupon's currency, and how the edit's result maps
 * to an outcome. Plus `patchCoupon`, the one new piece: a PARTIAL edit for the
 * MCP tools, read-merge-write over the page's full replace. The admin console and
 * the MCP tools both call these, so a guard here holds for both.
 * `coupons-page.sandbox.test.ts` pins the notices the console renders from these
 * outcomes; this file pins the outcomes.
 *
 * Real document store (in-memory SQLite, the host's migrations) and the client's
 * own stores.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	orderId,
	type CouponType,
} from "@urumi.ai/otta-domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { COUPON_CURRENCY_REFUSAL } from "../src/admin/coupon-currency-rules.js";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import {
	COUPON_CURRENCY_MOVED,
	createCoupon,
	deleteCoupon,
	patchCoupon,
	retireCoupon,
	updateCoupon,
} from "../src/admin/operations/index.js";
import * as pluginIndex from "../src/index.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;
let client: InProcessAdminRulesClient;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	client = new InProcessAdminRulesClient(harness.ctx);
});

afterAll(async () => {
	await harness?.close();
});

interface SeedRow {
	id: string;
	code: string;
	type?: CouponType;
	amountCents?: number | null;
	rateBps?: number | null;
	capCents?: number | null;
	currency?: string | null;
	minSubtotalCents?: number | null;
	startsAt?: string | null;
	expiresAt?: string | null;
	maxUses?: number | null;
	maxUsesPerCustomer?: number | null;
	uses?: number;
}

/** One coupon written straight to the store (a fixed 5.00 USD by default),
 *  redeemed `uses` times for real so the delete guard has rows to count. */
async function seed(row: SeedRow): Promise<void> {
	const type = row.type ?? "fixed_amount";
	const amount =
		row.amountCents === undefined ? (type === "fixed_amount" ? 500 : null) : row.amountCents;
	const cur = row.currency === undefined ? (type === "fixed_amount" ? "USD" : null) : row.currency;
	await harness.stores.couponStore.create({
		id: row.id,
		code: row.code,
		type,
		amountCents: amount === null ? null : cents(amount),
		rateBps: row.rateBps ?? (type === "percentage" ? 1000 : null),
		capCents: row.capCents == null ? null : cents(row.capCents),
		currency: cur === null ? null : toCurrency(cur),
		minSubtotalCents: row.minSubtotalCents == null ? null : cents(row.minSubtotalCents),
		startsAt: row.startsAt ?? null,
		expiresAt: row.expiresAt ?? null,
		maxUses: row.maxUses ?? null,
		maxUsesPerCustomer: row.maxUsesPerCustomer ?? null,
	});
	for (let i = 0; i < (row.uses ?? 0); i++) {
		const redeemed = await harness.stores.couponStore.redeem({
			couponId: row.id,
			orderId: orderId(`ops-order-${row.id}-${String(i)}`),
			idempotencyKey: idempotencyKey(`ops-use-${row.id}-${String(i)}`),
			createdAt: new Date().toISOString(),
		});
		expect(redeemed.ok).toBe(true);
	}
}

const stored = (id: string) => harness.stores.couponStore.findById(id);

const FIXED = {
	type: "fixed_amount",
	amountCents: 500,
	rateBps: null,
	capCents: null,
	currency: "USD",
	minSubtotalCents: null,
	startsAt: null,
	expiresAt: null,
	maxUses: null,
	maxUsesPerCustomer: null,
} as const;

describe("createCoupon", () => {
	test("a new coupon is `ok`, carrying the created row", async () => {
		const outcome = await createCoupon(client, { id: "c-new", code: "NEW5", ...FIXED });
		expect(outcome).toMatchObject({ kind: "ok", coupon: { id: "c-new", code: "NEW5" } });
		expect(await stored("c-new")).not.toBeNull();
	});

	test("a code another coupon has (whatever its case) is `code_taken`, naming the code", async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		const outcome = await createCoupon(client, { id: "c-other", code: "fiveoff", ...FIXED });
		expect(outcome).toEqual({ kind: "code_taken", code: "fiveoff", taken: "code" });
		expect(await stored("c-other")).toBeNull();
	});

	test('an ID another coupon has, with a free code, is `code_taken` with `taken: "id"`', async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		const outcome = await createCoupon(client, { id: "c-five", code: "BRANDNEW", ...FIXED });
		expect(outcome).toEqual({ kind: "code_taken", code: "BRANDNEW", taken: "id" });
	});

	test('the same ID and code again (a retried create) is `code_taken` with `taken: "same"`', async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		const outcome = await createCoupon(client, { id: "c-five", code: "FIVEOFF", ...FIXED });
		expect(outcome).toEqual({ kind: "code_taken", code: "FIVEOFF", taken: "same" });
	});

	test("a percentage cap with no currency is `currency_refused`, and nothing is written", async () => {
		const outcome = await createCoupon(client, {
			id: "c-pct",
			code: "PCT",
			type: "percentage",
			rateBps: 1000,
			capCents: 500,
			currency: null,
		});
		expect(outcome).toMatchObject({
			kind: "currency_refused",
			reason: COUPON_CURRENCY_REFUSAL.boundsNeedCurrency,
		});
		expect(await stored("c-pct")).toBeNull();
	});

	test("a currency not in the table is `currency_refused`", async () => {
		const outcome = await createCoupon(client, {
			id: "c-xyz",
			code: "XYZ",
			...FIXED,
			currency: "XYZ",
		});
		expect(outcome.kind).toBe("currency_refused");
	});

	test("a refusal on any other field is `invalid`, naming the field", async () => {
		const outcome = await createCoupon(client, {
			id: "c-big",
			code: "BIG",
			type: "percentage",
			rateBps: 200_000,
		});
		expect(outcome).toMatchObject({ kind: "invalid", field: "rateBps" });
		expect(await stored("c-big")).toBeNull();
	});
});

describe("createCoupon refuses a coupon without its own economics, before any write", () => {
	// A fixed_amount coupon is an amount IN a currency; a percentage coupon is its
	// rate. Without them the row is created but can never discount anything (the
	// domain's validate-coupon refuses it at checkout). `invalid`, so the page's
	// refusal net and the MCP tools' INVALID_INPUT both name the field.
	test.each([
		["fixed_amount without amountCents", { type: "fixed_amount", currency: "USD" }, "amountCents"],
		[
			"fixed_amount with amountCents null",
			{ type: "fixed_amount", amountCents: null, currency: "USD" },
			"amountCents",
		],
		["fixed_amount without currency", { type: "fixed_amount", amountCents: 500 }, "currency"],
		[
			"fixed_amount with currency null",
			{ type: "fixed_amount", amountCents: 500, currency: null },
			"currency",
		],
		["fixed_amount with neither (amount named first)", { type: "fixed_amount" }, "amountCents"],
		["percentage without rateBps", { type: "percentage" }, "rateBps"],
		["percentage with rateBps null", { type: "percentage", rateBps: null }, "rateBps"],
	] as const)("%s is `invalid`, nothing written", async (_name, economics, field) => {
		const outcome = await createCoupon(client, { id: "c-bare", code: "BARE", ...economics });
		expect(outcome).toMatchObject({ kind: "invalid", field });
		expect(await stored("c-bare")).toBeNull();
	});
});

describe("updateCoupon (full replace, as the page saves)", () => {
	test("an edit is `ok`, and a field it does not carry is cleared — the page's full replace", async () => {
		await seed({ id: "c-five", code: "FIVEOFF", minSubtotalCents: 3500, maxUses: 10 });
		const outcome = await updateCoupon(client, "c-five", {
			currency: "USD",
			amountCents: 700,
			rateBps: null,
			capCents: null,
			minSubtotalCents: 3500,
			startsAt: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		expect(outcome).toMatchObject({ kind: "ok", coupon: { amountCents: 700 } });
		expect(await stored("c-five")).toMatchObject({ amountCents: 700, maxUses: null });
	});

	test("a coupon that does not exist is `not_found`", async () => {
		expect(await updateCoupon(client, "c-ghost", { amountCents: 100 })).toEqual({
			kind: "not_found",
		});
	});

	test("a currency that no longer matches the stored one is `currency_refused` (moved), nothing written", async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		const outcome = await updateCoupon(client, "c-five", { currency: "EUR", amountCents: 600 });
		expect(outcome).toMatchObject({ kind: "currency_refused", reason: COUPON_CURRENCY_MOVED });
		expect((await stored("c-five"))?.amountCents).toBe(500);
	});

	test("blanking the coupon's own economic axis is `failed` (the route's 400)", async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		expect(await updateCoupon(client, "c-five", { currency: "USD", amountCents: null })).toEqual({
			kind: "failed",
			status: 400,
		});
	});

	test("blanking a percentage coupon's rate is `failed` (the route's 400), nothing written", async () => {
		await seed({ id: "c-pct", code: "PCT10", type: "percentage", rateBps: 1000 });
		expect(await updateCoupon(client, "c-pct", { rateBps: null })).toEqual({
			kind: "failed",
			status: 400,
		});
		expect((await stored("c-pct"))?.rateBps).toBe(1000);
	});

	test("clearing a fixed coupon's currency is refused (a set currency never changes), nothing written", async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		const outcome = await updateCoupon(client, "c-five", { currency: null, amountCents: 500 });
		expect(outcome).toMatchObject({ kind: "currency_refused", reason: COUPON_CURRENCY_MOVED });
		expect((await stored("c-five"))?.currency).toBe("USD");
	});

	test("a malformed coupon ID is `invalid`", async () => {
		expect(await updateCoupon(client, "c five", { amountCents: 100 })).toMatchObject({
			kind: "invalid",
			field: "couponId",
		});
	});
});

describe("patchCoupon (partial edit — MCP only)", () => {
	test("patching only maxUses keeps startsAt, expiresAt and minSpend", async () => {
		await seed({
			id: "c-win",
			code: "WINDOW",
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: "2026-12-31T23:59:59.999Z",
			minSubtotalCents: 3500,
			maxUses: 100,
			maxUsesPerCustomer: 2,
		});
		const outcome = await patchCoupon(client, "c-win", { maxUses: 5 });
		expect(outcome.kind).toBe("ok");
		const after = await stored("c-win");
		expect(after).toMatchObject({
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: "2026-12-31T23:59:59.999Z",
			minSubtotalCents: 3500,
			maxUses: 5,
			// …and everything else it did not mention, too.
			amountCents: 500,
			currency: "USD",
			maxUsesPerCustomer: 2,
		});
	});

	test("an explicit null in the patch clears that field, and only that one", async () => {
		await seed({
			id: "c-win",
			code: "WINDOW",
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: "2026-12-31T23:59:59.999Z",
			maxUses: 100,
		});
		expect((await patchCoupon(client, "c-win", { expiresAt: null })).kind).toBe("ok");
		expect(await stored("c-win")).toMatchObject({
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: null,
			maxUses: 100,
		});
	});

	test("an unbound percentage coupon keeps its economics and stays unbound", async () => {
		await seed({ id: "c-pct", code: "PCT", type: "percentage", rateBps: 1500, capCents: null });
		expect((await patchCoupon(client, "c-pct", { maxUsesPerCustomer: 1 })).kind).toBe("ok");
		expect(await stored("c-pct")).toMatchObject({
			rateBps: 1500,
			capCents: null,
			currency: null,
			maxUsesPerCustomer: 1,
		});
	});

	test("a coupon past the first page of the list is still found", async () => {
		for (let i = 0; i < 105; i++) {
			await seed({ id: `c-bulk-${String(i).padStart(3, "0")}`, code: `BULK${String(i)}` });
		}
		// Whichever end of the list it lands on, every one must be reachable.
		for (const id of ["c-bulk-000", "c-bulk-104"]) {
			expect((await patchCoupon(client, id, { maxUses: 7 })).kind, id).toBe("ok");
			expect((await stored(id))?.maxUses, id).toBe(7);
		}
	});

	test("a coupon that does not exist is `not_found`, and nothing is written", async () => {
		expect(await patchCoupon(client, "c-ghost", { maxUses: 5 })).toEqual({ kind: "not_found" });
	});

	test("a patch the rules client refuses comes back as its outcome, nothing written", async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		const outcome = await patchCoupon(client, "c-five", { currency: "EUR" });
		expect(outcome).toMatchObject({ kind: "currency_refused", reason: COUPON_CURRENCY_MOVED });
		expect((await stored("c-five"))?.currency).toBe("USD");
	});
});

describe("retireCoupon and deleteCoupon", () => {
	test("retire ends a live coupon, then answers `already_ended`; an unknown one is `not_found`", async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		const first = await retireCoupon(client, "c-five");
		expect(first.ok).toBe(true);
		expect(await retireCoupon(client, "c-five")).toEqual({ ok: false, reason: "already_ended" });
		expect(await retireCoupon(client, "c-ghost")).toEqual({ ok: false, reason: "not_found" });
	});

	test("delete of a redeemed coupon is withheld (`in_use`) and it survives", async () => {
		await seed({ id: "c-used", code: "USED", uses: 1 });
		expect(await deleteCoupon(client, "c-used")).toEqual({ ok: false, reason: "in_use" });
		expect(await stored("c-used")).not.toBeNull();
	});

	test("delete of an unredeemed coupon is `ok`, then `not_found`", async () => {
		await seed({ id: "c-five", code: "FIVEOFF" });
		expect(await deleteCoupon(client, "c-five")).toEqual({ ok: true });
		expect(await deleteCoupon(client, "c-five")).toEqual({ ok: false, reason: "not_found" });
	});
});

describe("the plugin's public entry exports the operations (MCP reuses them)", () => {
	test("every coupon operation is re-exported from the package index", () => {
		for (const name of [
			"createCoupon",
			"updateCoupon",
			"patchCoupon",
			"retireCoupon",
			"deleteCoupon",
		]) {
			expect(typeof (pluginIndex as Record<string, unknown>)[name], name).toBe("function");
		}
		expect((pluginIndex as Record<string, unknown>)["COUPON_CURRENCY_MOVED"]).toBe(
			COUPON_CURRENCY_MOVED,
		);
	});
});
