/**
 * The setup claim on the main suite's stack (ADR-0042): once the store is
 * claimed (the seed claims it), the gate is inert.
 *
 * The link flow needs an UNCLAIMED store, which this stack is not by the time
 * specs run, so it lives in `e2e/claim/` and runs on its own fresh stack under
 * `playwright.claim.config.ts` (`pnpm test:e2e:claim`).
 */
import { E2E_BASE_URL, expect, skipWithoutSite, test } from "./harness.js";

const STATUS = `${E2E_BASE_URL}/_emdash/api/setup/status`;

/** A bare request with no cookie: 403 only while the store is unclaimed. */
async function unclaimed(): Promise<boolean> {
	const res = await fetch(STATUS, { redirect: "manual" });
	await res.body?.cancel().catch(() => undefined);
	return res.status === 403;
}

test.describe("setup claim (ADR-0042)", () => {
	test("claimed: the gate is inert, no token needed", async ({ page }, testInfo) => {
		await skipWithoutSite(testInfo);
		test.skip(await unclaimed(), "this stack is unclaimed; the inert check needs a claimed one");
		const res = await page.request.get(STATUS);
		expect(res.status()).toBe(200);
		expect(await res.json()).toMatchObject({ data: { needsSetup: false } });
	});
});
