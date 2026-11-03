/**
 * The setup-claim link on a FRESH, unclaimed store, in a real browser
 * (ADR-0042). Runs under `playwright.claim.config.ts` only.
 *
 * The link is followed the way a deployer follows it: by a click on a page of
 * ANOTHER site. `127.0.0.1` and `localhost` are different sites to the browser,
 * so the click is a cross-site navigation, and a SameSite=Strict cookie set on
 * its response is only sent back if the hand-off to the clean URL is a
 * same-origin navigation (the gate's meta refresh), not a redirect chain that
 * began cross-site. The test asserts the wizard's own document then loads
 * (200), which it cannot do without the cookie.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import {
	SETUP_CLAIM_COOKIE,
	SETUP_CLAIM_COOKIE_PATH,
	SETUP_CLAIM_PATH,
	SETUP_TOKEN_PARAM,
	setupClaimUrl,
} from "../../src/lib/setup-claim-contract.js";
import { E2E_SETUP_TOKEN } from "../harness.js";
import { CLAIM_PROBE_HOST, CLAIM_SITE } from "./claim-stack.js";

const STATUS = `${CLAIM_SITE}/_emdash/api/setup/status`;

/** A page on another site whose only content is a link to `href`. */
async function linkPage(href: string): Promise<{ server: Server; url: string }> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><title>elsewhere</title><a id="go" href="${href}">Claim the store</a>`);
	});
	await new Promise<void>((resolve) => server.listen(0, CLAIM_PROBE_HOST, resolve));
	const { port } = server.address() as AddressInfo;
	return { server, url: `http://${CLAIM_PROBE_HOST}:${String(port)}/` };
}

test.describe("setup claim on a fresh store (ADR-0042)", () => {
	test("the store starts unclaimed: no token and a wrong token are refused", async ({ page }) => {
		const probe = await fetch(STATUS, { redirect: "manual" });
		expect(probe.status, "a fresh stack must be unclaimed").toBe(403);

		const bare = await page.goto(`${CLAIM_SITE}${SETUP_CLAIM_PATH}`);
		expect(bare?.status()).toBe(403);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			"This store hasn't been set up yet",
		);

		const wrong = await page.goto(
			`${CLAIM_SITE}${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=not-the-token`,
		);
		expect(wrong?.status()).toBe(403);
		expect(await page.context().cookies()).toEqual([]);
	});

	test("a CROSS-SITE click on the link lands on the wizard, with the Strict cookie", async ({
		page,
	}) => {
		const { server, url } = await linkPage(setupClaimUrl(CLAIM_SITE, E2E_SETUP_TOKEN));
		try {
			await page.goto(url);
			const wizard = page.waitForResponse(
				(res) =>
					res.request().isNavigationRequest() &&
					new URL(res.url()).pathname === SETUP_CLAIM_PATH &&
					!new URL(res.url()).searchParams.has(SETUP_TOKEN_PARAM),
			);
			await page.locator("#go").click();
			const document = await wizard;
			expect(document.status(), "the wizard's document, after the refresh").toBe(200);
			// The response can arrive before the navigation commits: wait for it.
			await page.waitForURL(
				(u) => u.pathname === SETUP_CLAIM_PATH && !u.searchParams.has(SETUP_TOKEN_PARAM),
			);

			// The admin shell is what loaded, not the refusal page: it boots, and no
			// refusal appears once its own API calls (which need the cookie) are made.
			await expect(page.getByText("Loading EmDash")).toHaveCount(0, { timeout: 150_000 });
			await expect(page.getByText("This store hasn't been set up yet")).toHaveCount(0);
			await expect(page.getByText("SETUP_CLAIM_REQUIRED")).toHaveCount(0);

			// Cookies are looked up by URL, path included: the claim cookie is
			// scoped to /_emdash/.
			const claim = (await page.context().cookies(`${CLAIM_SITE}${SETUP_CLAIM_PATH}`)).find(
				(c) => c.name === SETUP_CLAIM_COOKIE,
			);
			expect(claim).toMatchObject({
				value: E2E_SETUP_TOKEN,
				path: SETUP_CLAIM_COOKIE_PATH,
				httpOnly: true,
				sameSite: "Strict",
			});
			// The wizard's own API call carries the cookie and gets through.
			const status = await page.request.get(STATUS);
			expect(status.status()).toBe(200);
			expect(await status.json()).toMatchObject({ data: { needsSetup: true } });
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
