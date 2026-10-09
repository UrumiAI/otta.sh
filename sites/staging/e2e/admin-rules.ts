/**
 * Store-rule setup for the region e2e specs: the plugin's admin route, driven
 * the way the Block Kit console drives it (dev-bypass session, form submits
 * with the form's own `block_id`, promoted buttons' values). Not a spec.
 */
import { E2E_BASE_URL, expect } from "./harness.js";

const ADMIN = `${E2E_BASE_URL}/_emdash/api/plugins/otta/admin`;

export type Block = Record<string, unknown>;

export async function adminHeaders(): Promise<Record<string, string>> {
	const res = await fetch(`${E2E_BASE_URL}/_emdash/api/auth/dev-bypass`, { redirect: "manual" });
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";", 1)[0])
		.join("; ");
	return { Cookie: cookie, "Content-Type": "application/json", "X-EmDash-Request": "1" };
}

export async function admin(headers: Record<string, string>, body: unknown): Promise<Block[]> {
	const res = await fetch(ADMIN, { method: "POST", headers, body: JSON.stringify(body) });
	expect(res.ok, `admin ${JSON.stringify(body).slice(0, 120)} → HTTP ${res.status}`).toBe(true);
	const envelope = (await res.json()) as { data?: { blocks?: Block[] } };
	return envelope.data?.blocks ?? [];
}

/** Every object in a block tree (forms, buttons, groups' children…). */
export function everything(node: unknown, out: Block[] = []): Block[] {
	if (Array.isArray(node)) for (const item of node) everything(item, out);
	else if (node !== null && typeof node === "object") {
		out.push(node as Block);
		for (const value of Object.values(node)) everything(value, out);
	}
	return out;
}

/** The `block_id` of the form whose submit is `actionId` — where the zone/method context rides. */
export function formBlockId(blocks: Block[], actionId: string): unknown {
	const form = everything(blocks).find(
		(b) => b["type"] === "form" && (b["submit"] as Block | undefined)?.["action_id"] === actionId,
	);
	return form?.["block_id"];
}

export const pathToken = (path: string[]): string =>
	Buffer.from(JSON.stringify(path)).toString("base64url");

/** Put one purchasable product in a new cart (the page's own cart cookie). */
export async function addOneToCart(
	page: import("@playwright/test").Page,
	skip: () => Promise<void>,
): Promise<void> {
	await page.goto("/products");
	const hrefs = [
		...new Set(
			await page
				.locator('a[href^="/products/"]')
				.evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")),
		),
	].filter((href) => /^\/products\/[^/?#]+$/.test(href));
	const addToCart = page.locator('form[action="/cart/add"] button[type="submit"]');
	for (const href of hrefs.slice(0, 12)) {
		await page.goto(href);
		if ((await addToCart.count()) > 0 && (await addToCart.first().isEnabled())) {
			await Promise.all([
				page.waitForResponse((res) => new URL(res.url()).pathname === "/cart/add"),
				addToCart.first().click(),
			]);
			await page.waitForLoadState("load");
			return;
		}
	}
	await skip();
}
