/**
 * The customer magic-link login, in a REAL browser (issue #306).
 *
 * WHY A BROWSER. The unit suite drives the account endpoints with hand-built
 * `Origin` headers, so it could not see the bug this file was written for: the
 * verify page declared `referrer: no-referrer`, and under that policy a browser
 * sends `Origin: null` on the page's own form POST. The site's CSRF guard reads
 * "null" as cross-origin and 403s — so every login failed at
 * `/account/verify/confirm` while every unit test passed. Only a browser decides
 * what `Origin` a form submission carries, so only a browser can pin it.
 *
 * WHAT IS HERE, AND WHY NOT THE WHOLE JOURNEY. Both cases need only the site:
 *  1. The login form's POST reaches the plugin and ends on the generic notice.
 *  2. The verify form's POST is not refused as cross-origin. A made-up
 *     challenge is redeemed and fails as an INVALID link. The point is that it
 *     reached the plugin at all rather than dying at the guard.
 * The full request → email → verify → orders → logout journey is NOT browsable
 * here. The plugin's email goes through EmDash's `ctx.email` (ADR-0031), and
 * this suite cannot read the mail the site's EmDash email provider delivers, so
 * there is no token to follow. That journey, including the
 * captured email, single use, the cookie flags and logout, is proven in the
 * workerd sandbox suite (`packages/plugin/test/account-routes.sandbox.test.ts`).
 * The site endpoints are proven in `sites/staging/test/account.test.ts`.
 */
import { expect, skipWithoutSite, test } from "./harness.js";

test.describe("customer login in the browser", () => {
	test("the verify page's own POST is same-origin: it reaches the plugin, not a 403", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.goto("/account/verify?challenge=e2e-not-a-challenge&token=e2e-not-a-token");

		const [confirm] = await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/account/verify/confirm"),
			page.getByRole("button", { name: "Continue signing in" }).click(),
		]);

		// THE ASSERTION: not refused by the origin guard. A made-up link is then
		// an honest INVALID, which is the plugin's answer, not the guard's.
		expect(confirm.status(), "the verify POST was refused as cross-origin").not.toBe(403);
		expect(confirm.status()).toBe(303);
		await expect(page).toHaveURL(/\/account\/login\?error=LOGIN_LINK_INVALID$/);
	});

	test("the login form's POST reaches the plugin and ends on the generic notice", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.goto("/account/login");
		await page.getByLabel("Email").fill(`e2e-${Date.now()}@example.test`);
		const [request] = await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/account/login/request"),
			page.getByRole("button", { name: "Email me a sign-in link" }).click(),
		]);
		expect(request.status(), "the login POST was refused as cross-origin").toBe(303);
		await expect(page).toHaveURL(/\/account\/login\?sent=1$/);
		await expect(page.getByText("A sign-in link is on its way")).toBeVisible();
	});
});
