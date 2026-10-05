/**
 * The SIGNED-IN account, in a REAL browser (e2e follow-up to issue #378).
 *
 * `cart-account-orders.spec.ts` stops at "a sign-in link is on its way": the
 * link travels by email, the plugin's email egress is `ctx.http`, and
 * `ctx.http` refuses loopback, so no local mailbox can receive it. This spec
 * picks up from there. The dev server runs the dev-only login-link capture
 * (`OTTA_E2E_LOGIN_CAPTURE=1`, set by `playwright.config.ts` when it boots the
 * stack): with no email provider configured, the plugin keeps the link in its
 * own kv instead of mailing it, and `login-link-capture.ts` reads it back from
 * the dev server's local D1 file. No route serves it.
 *
 * Everything else is the real thing: the shopper asks for the link on
 * /account/login, opens it, and confirms on /account/verify, through the same
 * forms, origin guard and session cookie a deployment uses.
 *
 *  1. Sign in → the order placed for that address is listed → it opens → sign
 *     out → the account pages send a signed-out visitor to sign-in, and the
 *     used link does not sign anyone in again.
 *  2. A SECOND address signs in and sees none of the first address's orders:
 *     not in the list, and not by the order's own account URL.
 *
 * HOW THE ORDERS EXIST. Placed through the public storefront routes for the
 * spec's own address and paid with a signed test webhook
 * (`seed-e2e-orders.ts`), under the dev-only offline Stripe gateway
 * (`OTTA_E2E_STRIPE_OFFLINE=1`). Each run uses fresh addresses, so a re-run
 * against the same stack starts from an empty account.
 *
 * IT WRITES: orders, captures, sign-in challenges and sessions, and the
 * store's sign-in page address (`settings:loginLinkUrl`, set to this site's
 * /account/verify). Point it only at a local stack.
 */
import type { Page, TestInfo } from "@playwright/test";
import { cmsAuthHeaders } from "../scripts/seed-demo-commerce.js";
import {
	E2E_WEBHOOK_SECRET,
	findPurchasable,
	orderLineTitles,
	placeOrder,
	provisionLoginLinkUrl,
	provisionWebhookSecret,
	settleOrder,
	type SeedOrdersDeps,
} from "../scripts/seed-e2e-orders.js";
import {
	E2E_BASE_URL,
	expect,
	skipWithoutLoginCapture,
	skipWithoutPurchasableProduct,
	skipWithoutSite,
	test,
} from "./harness.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { waitForCapturedLoginLink } from "./login-link-capture.js";

/** The street every spec order ships to (`placeOrder`'s address). */
const SHIP_STREET = "1 Test Street";

/** A fresh address per run (and per role), lower-case like the store keeps it.
 *  `.test` is reserved (RFC 2606): nothing sent to it can reach anyone. */
function freshEmail(role: string): string {
	return `e2e-account-${role}-${String(Date.now())}@example.test`;
}

/** Point sign-in links at this site, and place a PAID order for `email`.
 *  Returns its id and the titles its lines were bought under. */
async function paidOrderFor(
	testInfo: TestInfo,
	email: string,
): Promise<{ orderId: string; titles: string[] }> {
	const deps: SeedOrdersDeps = {
		siteUrl: E2E_BASE_URL,
		authHeaders: await cmsAuthHeaders(E2E_BASE_URL),
		webhookSecret: E2E_WEBHOOK_SECRET,
	};
	await provisionWebhookSecret(deps);
	await provisionLoginLinkUrl(deps);
	const product = await findPurchasable(deps).catch(() => null);
	if (product === null) await skipWithoutPurchasableProduct(testInfo);
	if (product === null) throw new Error("unreachable: skipped");
	const orderId = await placeOrder(deps, product, email);
	expect(await settleOrder(deps, orderId)).toBe("paid");
	const titles = await orderLineTitles(deps, orderId);
	expect(titles.length, `order ${orderId} has no line titles`).toBeGreaterThan(0);
	return { orderId, titles };
}

/**
 * Sign `email` in through the real UI: request the link, read the captured
 * link, open it, confirm. Returns the link (so a spec can try it again). Ends
 * on /account/orders, where a successful sign-in lands.
 */
async function signIn(page: Page, testInfo: TestInfo, email: string): Promise<string> {
	await page.goto("/account/login");
	await page.getByLabel("Email").fill(email);
	// A second of slack for the server's clock: the capture is stamped by the
	// worker, and the address is fresh anyway.
	const since = Date.now() - 1_000;
	const [request] = await Promise.all([
		page.waitForResponse((res) => new URL(res.url()).pathname === "/account/login/request"),
		page.getByRole("button", { name: "Email me a sign-in link" }).click(),
	]);
	expect(request.status()).toBe(303);
	await expect(page).toHaveURL(/\/account\/login\?sent=1$/);

	let link = "";
	try {
		link = await waitForCapturedLoginLink(email, { since });
	} catch (err) {
		await skipWithoutLoginCapture(testInfo, err instanceof Error ? err.message : String(err));
	}
	// The link names THIS site's verify page — the address the spec saved — and
	// carries the challenge and token the page will post.
	const url = new URL(link);
	expect(url.origin).toBe(new URL(E2E_BASE_URL).origin);
	expect(url.pathname).toBe("/account/verify");
	expect(url.searchParams.get("challenge")).toBeTruthy();
	expect(url.searchParams.get("token")).toBeTruthy();

	await page.goto(link);
	await Promise.all([
		page.waitForURL(/\/account\/orders$/),
		page.getByRole("button", { name: "Continue signing in" }).click(),
	]);
	await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
	return link;
}

test.describe("the signed-in account, in the browser", () => {
	// A cold storefront compiles each account page on its first visit.
	test.slow();

	test("sign in by the emailed link, see and open the order, sign out", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		const email = freshEmail("owner");
		const { orderId, titles } = await paidOrderFor(testInfo, email);
		const link = await signIn(page, testInfo, email);

		// ── /account/orders lists the order, and only it ───────────────────────
		const orderHref = `/account/orders/${encodeURIComponent(orderId)}`;
		const rows = page.locator(".account-orders-row");
		await expect(rows).toHaveCount(1);
		const row = rows.filter({ has: page.locator(`a[href="${orderHref}"]`) });
		await expect(row).toHaveCount(1);
		await expect(row.locator(".account-orders-state")).toHaveText("Paid");
		await expect(row.locator(".account-orders-items")).toHaveText("1 item");

		// ── /account/orders/<id> ───────────────────────────────────────────────
		await row.locator(`a[href="${orderHref}"]`).click();
		await expect(page).toHaveURL(new RegExp(`${orderHref}$`));
		await expect(page.locator("h1.account-order-title")).toBeVisible();
		await expect(page.locator(".account-order-state")).toContainText("Paid");
		await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
		await expect(page.locator(`a.account-order-link[href="/orders/${orderId}"]`)).toBeVisible();
		// The owner sees what the second spec proves another address does NOT:
		// the products, the totals and the delivery address.
		for (const title of titles) {
			await expect(page.locator(".account-order-panel").getByText(title).first()).toBeVisible();
		}
		await expect(page.getByRole("heading", { name: "Totals" })).toBeVisible();
		await expect(page.locator(".account-order-address")).toContainText(SHIP_STREET);

		// ── Sign out ───────────────────────────────────────────────────────────
		await page.getByRole("link", { name: "← Your orders" }).click();
		await expect(page).toHaveURL(/\/account\/orders$/);
		await Promise.all([
			page.waitForURL(/\/\?signed-out=1$/),
			page.getByRole("button", { name: "Sign out" }).click(),
		]);
		// The session is gone, server-side and in the browser: both account pages
		// send the visitor to sign-in.
		await page.goto("/account/orders");
		await expect(page).toHaveURL(/\/account\/login$/);
		await page.goto(orderHref);
		await expect(page).toHaveURL(/\/account\/login$/);

		// The link was single-use: following it again signs nobody in.
		await page.goto(link);
		await Promise.all([
			page.waitForURL(/\/account\/login\?error=/),
			page.getByRole("button", { name: "Continue signing in" }).click(),
		]);
		await expect(page).toHaveURL(/\/account\/login\?error=LOGIN_LINK_USED$/);
	});

	test("a second address cannot see the first address's order", async ({ page }, testInfo) => {
		await skipWithoutSite(testInfo);
		const owner = freshEmail("first");
		const { orderId, titles } = await paidOrderFor(testInfo, owner);
		const other = freshEmail("second");
		await signIn(page, testInfo, other);

		// Not in the list: this address has placed nothing.
		const orderHref = `/account/orders/${encodeURIComponent(orderId)}`;
		await expect(page.locator(".account-orders-row")).toHaveCount(0);
		await expect(page.locator(".account-orders-empty")).toBeVisible();
		await expect(page.locator(`a[href="${orderHref}"]`)).toHaveCount(0);

		// Not by its own account URL either: NOT FOUND for this session, saying
		// so in the not-found words, and with nothing of the order on the page —
		// not its products, state, items or totals, delivery address, or link.
		const res = await page.goto(orderHref);
		expect(res?.status()).toBe(404);
		await expect(page).toHaveURL(new RegExp(`${orderHref}$`));
		await expect(page.locator(".account-order-notice-slot")).toContainText(
			cartErrorMessage("ORDER_NOT_FOUND"),
		);
		await expect(page.locator("h1.account-order-title")).toHaveText("Order");
		for (const title of titles) await expect(page.getByText(title)).toHaveCount(0);
		await expect(page.locator(".account-order-state")).toHaveCount(0);
		await expect(page.locator(".account-order-panel")).toHaveCount(0);
		await expect(page.getByRole("heading", { name: "Totals" })).toHaveCount(0);
		await expect(page.locator(".account-order-address")).toHaveCount(0);
		await expect(page.getByText(SHIP_STREET)).toHaveCount(0);
		await expect(page.locator(`a[href^="/orders/${orderId}"]`)).toHaveCount(0);
	});
});
