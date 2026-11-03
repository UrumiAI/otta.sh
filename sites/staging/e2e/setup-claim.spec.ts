/**
 * The setup claim in a real browser (ADR-0042).
 *
 * Which half runs depends on the stack. An UNCLAIMED stack (fresh `.wrangler`
 * state, no seed) runs the link flow. It does not finish the wizard, so the
 * stack stays unclaimed. A CLAIMED stack (any seeded run, CI included) checks
 * that the gate is inert. The other half skips and says why.
 */
import {
	SETUP_CLAIM_COOKIE,
	SETUP_CLAIM_COOKIE_PATH,
	SETUP_CLAIM_PATH,
	SETUP_TOKEN_PARAM,
} from "../src/lib/setup-claim-contract.js";
import { E2E_BASE_URL, E2E_SETUP_TOKEN, expect, skipWithoutSite, test } from "./harness.js";

const STATUS = `${E2E_BASE_URL}/_emdash/api/setup/status`;

/** A bare request with no cookie: 403 only while the store is unclaimed. */
async function unclaimed(): Promise<boolean> {
	const res = await fetch(STATUS, { redirect: "manual" });
	await res.body?.cancel().catch(() => undefined);
	return res.status === 403;
}

test.describe("setup claim (ADR-0042)", () => {
	test("unclaimed: no token and a wrong token are refused; the link sets the cookie and leaves the URL", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		test.skip(
			!(await unclaimed()),
			"this stack is already claimed; the link flow needs a fresh one",
		);

		const bare = await page.goto(SETUP_CLAIM_PATH);
		expect(bare?.status()).toBe(403);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			"This store hasn't been set up yet",
		);

		const wrong = await page.goto(`${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=not-the-token`);
		expect(wrong?.status()).toBe(403);
		expect(await page.context().cookies()).toEqual([]);

		await page.goto(`${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${E2E_SETUP_TOKEN}`);
		await page.waitForURL((url) => !url.searchParams.has(SETUP_TOKEN_PARAM));
		expect(new URL(page.url()).pathname).toBe(SETUP_CLAIM_PATH);
		const claim = (await page.context().cookies()).find((c) => c.name === SETUP_CLAIM_COOKIE);
		expect(claim).toMatchObject({
			value: E2E_SETUP_TOKEN,
			path: SETUP_CLAIM_COOKIE_PATH,
			httpOnly: true,
			sameSite: "Strict",
		});
		// The wizard's own API call now carries the cookie and gets through.
		const status = await page.request.get(STATUS);
		expect(status.status()).toBe(200);
	});

	test("claimed: the gate is inert, no token needed", async ({ page }, testInfo) => {
		await skipWithoutSite(testInfo);
		test.skip(await unclaimed(), "this stack is unclaimed; the inert check needs a claimed one");
		const res = await page.request.get(STATUS);
		expect(res.status()).toBe(200);
		expect(await res.json()).toMatchObject({ data: { needsSetup: false } });
	});
});
