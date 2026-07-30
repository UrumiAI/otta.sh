import { describe, expect, test } from "vitest";
import { editProductCommerceBody, upsertProductCommerceBody } from "../src/schemas.js";

// ADR-0013 rung 3, in the FAST LOOP. The HTTP half of this guard lives in
// `admin-product-edit-http.test.ts`, which is `describe.skipIf(PG === undefined)`
// — so under a bare `pnpm test` it does not run at all, and the ladder's whole
// thesis is defence in depth. These cases need no server and no database, so
// they fire on every local run: if someone deletes `.strict()` from
// `editProductCommerceBody`, this file goes red immediately rather than waiting
// for CI's integration job.
//
// What is NOT asserted here, and must stay in the HTTP test: that the STORED
// title is unchanged. A schema test cannot see a database, and "rejected" vs
// "silently stripped" is only distinguishable by reading the row back.

const WATERMARK = "2026-07-10T01:00:00.000Z";

describe("editProductCommerceBody is strict, and title is not editable (ADR-0013)", () => {
	test("REJECTS a body carrying `title`, and the issue NAMES the field", () => {
		const res = editProductCommerceBody.safeParse({
			expectedUpdatedAt: WATERMARK,
			title: "Renamed from a stale client",
		});

		expect(res.success).toBe(false);
		if (res.success) throw new Error("unreachable");
		const unrecognized = res.error.issues.find((i) => i.code === "unrecognized_keys");
		expect(unrecognized).toBeDefined();
		expect(JSON.stringify(unrecognized)).toContain("title");
	});

	test("does not merely STRIP `title` — the schema must fail, not quietly succeed", () => {
		// The regression this pins: without `.strict()`, zod's default object
		// behaviour drops the key and returns `success: true`, so a merchant's
		// rename vanishes behind a 200. Asserting `success === false` is the only
		// thing that tells the two apart at this layer.
		const res = editProductCommerceBody.safeParse({
			expectedUpdatedAt: WATERMARK,
			price: { amount: 2599, currency: "USD" },
			title: "Renamed from a stale client",
		});
		expect(res.success).toBe(false);
	});

	test("any unknown key is rejected, not just `title` — the guard is general", () => {
		const res = editProductCommerceBody.safeParse({
			expectedUpdatedAt: WATERMARK,
			active: true,
			contentUpdatedAt: WATERMARK,
		});
		expect(res.success).toBe(false);
	});

	test("a legitimate commerce-owned edit still parses", () => {
		const res = editProductCommerceBody.safeParse({
			expectedUpdatedAt: WATERMARK,
			sku: "SKU-1",
			price: { amount: 2599, currency: "USD" },
			taxClass: "reduced",
			productKind: "physical",
			inventoryPolicy: "deny",
		});
		expect(res.success).toBe(true);
	});
});

describe("upsertProductCommerceBody keeps title and is deliberately NOT strict (the asymmetry)", () => {
	test("accepts `title` — the CMS content sync's one sanctioned channel", () => {
		const res = upsertProductCommerceBody.safeParse({ title: "Renamed by the CMS" });
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.title).toBe("Renamed by the CMS");
	});

	test("tolerates an unknown key rather than 400ing an integrator", () => {
		// Pins the asymmetry itself, so "tidying up" the two schemas to match
		// breaks a test instead of silently changing the integrator contract.
		const res = upsertProductCommerceBody.safeParse({
			title: "Renamed by the CMS",
			somethingAnIntegratorSent: 1,
		});
		expect(res.success).toBe(true);
	});
});
