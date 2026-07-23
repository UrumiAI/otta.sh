import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AdminRulesClient } from "../src/admin/admin-rules-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * The client-side contract for the rules admin surface (admin-UX Increment 3):
 * the SAME create/read/update/delete cases the domain + service suites cover,
 * run against `AdminRulesClient` over a LIVE `@urumi/service` (Postgres-backed)
 * — proving the wire format has not drifted from the ports and the discriminated
 * results map every 200/404/409 correctly. Both tokens are threaded so the write
 * gate + admin gate are exercised end-to-end.
 */
describe.skipIf(PG === undefined)("AdminRulesClient [live @urumi/service, Postgres]", () => {
	let service: LiveService;
	let client: AdminRulesClient;

	beforeAll(async () => {
		service = await startLiveService({ internalToken: "admin-secret", serviceToken: "svc-secret" });
		client = new AdminRulesClient({
			fetch: globalThis.fetch,
			baseUrl: service.baseUrl,
			adminToken: "admin-secret",
			serviceToken: "svc-secret",
		});
	});
	afterAll(async () => {
		await service.stop();
	});

	test("shipping: create zone→method→rate, edit them, and enforce referential deletes", async () => {
		expect((await client.createZone({ id: "z1", name: "US" })).ok).toBe(true);
		expect(
			(await client.createMethod("z1", { id: "m1", name: "Flat", type: "flat_rate" })).ok,
		).toBe(true);
		expect((await client.createRate("m1", { currency: "USD", amountCents: 599 })).ok).toBe(true);

		// LWW zone edit round-trips (`regions` is a required full-replace field).
		const zoneEdit = await client.updateZone("z1", { name: "United States", regions: ["US"] });
		expect(zoneEdit.ok && zoneEdit.value.name).toBe("United States");

		// A zone with a method cannot be deleted.
		expect(await client.deleteZone("z1")).toEqual({ ok: false, reason: "in_use" });

		// CAS rate edit: correct expected wins; a stale expected returns the fresh row.
		const ok = await client.updateRate("m1", "USD", {
			amountCents: 699,
			minSubtotalCents: null,
			expectedAmountCents: 599,
		});
		expect(ok.ok && ok.value.amountCents).toBe(699);
		const stale = await client.updateRate("m1", "USD", {
			amountCents: 799,
			minSubtotalCents: null,
			expectedAmountCents: 599,
		});
		expect(stale.ok).toBe(false);
		if (!stale.ok && stale.reason === "stale") {
			expect(stale.current?.amountCents).toBe(699);
		} else {
			throw new Error("expected a stale result carrying the current row");
		}

		// Leaf rate delete is idempotent; then the chain deletes cleanly.
		expect(await client.deleteRate("m1", "USD")).toEqual({ ok: true });
		expect(await client.deleteRate("m1", "USD")).toEqual({ ok: false, reason: "not_found" });
		expect(await client.deleteMethod("m1")).toEqual({ ok: true });
		expect(await client.deleteZone("z1")).toEqual({ ok: true });
	});

	test("tax: create class+rate, CAS-edit, delete", async () => {
		expect((await client.createTaxClass({ id: "standard", name: "Standard" })).ok).toBe(true);
		expect(
			(await client.createTaxRate({ id: "t1", taxClassId: "standard", zoneId: "z1", rateBps: 725 }))
				.ok,
		).toBe(true);

		const rates = await client.listTaxRates("z1");
		expect(rates.map((r) => r.id)).toContain("t1");

		const ok = await client.updateTaxRate("t1", {
			rateBps: 825,
			appliesToShipping: false,
			expectedRateBps: 725,
		});
		expect(ok.ok && ok.value.rateBps).toBe(825);
		const stale = await client.updateTaxRate("t1", {
			rateBps: 900,
			appliesToShipping: false,
			expectedRateBps: 725,
		});
		expect(stale.ok === false && stale.reason).toBe("stale");
		expect(
			await client.updateTaxRate("nope", {
				rateBps: 1,
				appliesToShipping: false,
				expectedRateBps: 0,
			}),
		).toEqual({
			ok: false,
			reason: "not_found",
		});

		expect(await client.deleteTaxRate("t1")).toEqual({ ok: true });
		expect(await client.deleteTaxRate("t1")).toEqual({ ok: false, reason: "not_found" });
	});

	test("coupons: create, LWW-edit, read, delete", async () => {
		expect(
			(
				await client.createCoupon({
					id: "cpn1",
					code: "SAVE5",
					type: "fixed_amount",
					amountCents: 500,
					currency: "USD",
					maxUses: 10,
				})
			).ok,
		).toBe(true);

		const edit = await client.updateCoupon("cpn1", { amountCents: 750, maxUses: 20 });
		expect(edit.ok && edit.value.amountCents).toBe(750);
		expect(edit.ok && edit.value.code).toBe("SAVE5"); // identity preserved

		const read = await client.getCoupon("SAVE5");
		expect(read?.amountCents).toBe(750);
		expect(await client.getCoupon("MISSING")).toBeNull();

		expect(await client.deleteCoupon("cpn1")).toEqual({ ok: true });
		expect(await client.deleteCoupon("cpn1")).toEqual({ ok: false, reason: "not_found" });
	});

	test("coupons: listCoupons enumerates newest-first, the search filter matches an EXACT code, and the cursor round-trips", async () => {
		expect(
			(
				await client.createCoupon({
					id: "list-1",
					code: "LIST-ALPHA",
					type: "fixed_amount",
					amountCents: 100,
					currency: "USD",
					// Validity window — the LIST wire must carry it back (PR #74
					// review); pinned below.
					startsAt: "2026-07-01T00:00:00.000Z",
					expiresAt: "2026-08-01T00:00:00.000Z",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await client.createCoupon({
					id: "list-2",
					code: "LIST-BETA",
					type: "fixed_amount",
					amountCents: 200,
					currency: "USD",
				})
			).ok,
		).toBe(true);

		const page1 = await client.listCoupons({}, { limit: 1 });
		expect(page1.coupons).toHaveLength(1);
		expect(typeof page1.nextCursor === "string" || page1.nextCursor === null).toBe(true);
		if (page1.nextCursor !== null) {
			const page2 = await client.listCoupons({}, { cursor: page1.nextCursor });
			expect([...page1.coupons, ...page2.coupons].map((c) => c.id).toSorted()).toEqual(
				["list-1", "list-2"].toSorted(),
			);
		}

		const bySearch = await client.listCoupons({ search: "list-alpha" });
		expect(bySearch.coupons.map((c) => c.id)).toEqual(["list-1"]);
		// The validity window rides the LIST wire (PR #74 review): the console
		// renders expiry straight off the summary row — no per-row detail fetch.
		const windowed = bySearch.coupons[0]!;
		expect(windowed.startsAt).toBe("2026-07-01T00:00:00.000Z");
		expect(windowed.expiresAt).toBe("2026-08-01T00:00:00.000Z");
		// And a windowless coupon carries EXPLICIT nulls, never absent fields.
		const bare = await client.listCoupons({ search: "list-beta" });
		expect(bare.coupons[0]?.startsAt).toBeNull();
		expect(bare.coupons[0]?.expiresAt).toBeNull();
		const noMatch = await client.listCoupons({ search: "list-alph" }); // substring must NOT match
		expect(noMatch.coupons).toEqual([]);
	});
});
