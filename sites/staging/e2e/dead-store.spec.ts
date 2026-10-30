/**
 * #659 (follow-up to #653 / #140): a dead content store answers 503 end to
 * end, against a real D1.
 *
 * `test/content-store.test.ts` proves the probe against better-sqlite3 and
 * `test/catalog-pages.test.ts` only regex-checks that the pages call it. Neither
 * renders a page against a database, and neither shows that D1 (workerd's
 * SQLite, behind emdash's Kysely dialect) fails the way plain SQLite does. This
 * spec renames `ec_products` in the dev server's LOCAL D1 file and watches one
 * product page go 200 → 503 → 200, and the shop page with it. What it proves is
 * the pages' outcome: from outside it cannot tell the probe's verdict from a
 * loader that surfaced the error itself. The probe's own logic is the unit
 * tier's to prove.
 *
 * LOCAL ONLY, by construction: the rename goes through `./local-d1.js`, which
 * can only open a file under this worktree's `sites/staging/.wrangler` state.
 * There is no binding name, no account and no `--remote` anywhere to get wrong.
 *
 * RESTORED THREE WAYS. The body puts the table back itself, so it can check the
 * store reads again. `test.afterAll` puts it back if the body failed first, and
 * only if THIS run parked it. And `global-setup.ts`, like the body's own first
 * step, heals a table an interrupted run left parked, so the next run starts
 * whole. If both the live and the parked table exist, it stops and says so
 * rather than guess.
 *
 * It needs a seeded stack (a product to break); without one it skips, or fails
 * under `OTTA_E2E_REQUIRE_SITE=1`.
 */
import type Database from "better-sqlite3";
import type { Page } from "@playwright/test";
import {
	expect,
	skipWithoutLocalD1,
	skipWithoutProducts,
	skipWithoutSite,
	test,
} from "./harness.js";
import {
	CONTENT_TABLE,
	D1_DIR,
	healParkedTable,
	openContentDb,
	PARKED_TABLE,
	renameTable,
} from "./local-d1.js";

/** The first product the shop links to, as `/products/<slug>`; `null` if none. */
async function firstProductPath(page: Page): Promise<string | null> {
	await page.goto("/products");
	const hrefs = await page
		.locator('a[href^="/products/"]')
		.evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
	return hrefs.find((href) => /^\/products\/[^/?#]+$/.test(href)) ?? null;
}

test.describe("a missing products table is an outage, not a missing product (#659)", () => {
	test.slow();

	let db: Database.Database | undefined;
	/** True only between THIS run's rename and its restore. */
	let parked = false;

	function restore(): void {
		if (db === undefined || !parked) return;
		renameTable(db, PARKED_TABLE, CONTENT_TABLE);
		parked = false;
	}

	test.afterAll(() => {
		// The body restores on success. This runs when it did not get that far.
		// A failure here is reported on its own, so it cannot hide the body's.
		try {
			restore();
		} finally {
			db?.close();
			db = undefined;
		}
	});

	test("one product page goes 200 → 503 + Retry-After → 200, and the shop says the catalog is unavailable", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		db = openContentDb();
		if (db === undefined) {
			skipWithoutLocalD1(testInfo, D1_DIR, CONTENT_TABLE);
			return;
		}
		// An interrupted earlier run may have left the table parked. Throws,
		// before any rename, if both tables exist.
		healParkedTable(db);

		// On a live store: a real product reads, and an unknown address is a
		// genuine 404, so the 503s below come from the missing table and not
		// from every miss.
		const pdpPath = await firstProductPath(page);
		await skipWithoutProducts(testInfo, pdpPath === null ? 0 : 1);
		if (pdpPath === null) return;
		const live = await page.goto(pdpPath);
		expect(live?.status(), `${pdpPath} on a live store`).toBe(200);
		const miss = await page.goto("/products/no-such-product-659");
		expect(miss?.status()).toBe(404);
		expect(miss?.headers()["retry-after"]).toBeUndefined();

		renameTable(db, CONTENT_TABLE, PARKED_TABLE);
		parked = true;

		const pdp = await page.goto(pdpPath);
		expect(pdp?.status(), `${pdpPath} with the products table gone`).toBe(503);
		expect(pdp?.headers()["retry-after"]).toBe("60");
		await expect(page.getByRole("heading", { name: "This product is unavailable." })).toBeVisible();
		await expect(page).toHaveTitle(/Product unavailable/);

		const plp = await page.goto("/products");
		expect(plp?.status(), "shop page with the products table gone").toBe(503);
		expect(plp?.headers()["retry-after"]).toBe("60");
		await expect(page.getByText("The catalog is unavailable right now.")).toBeVisible();
		await expect(page.getByRole("link", { name: /Open the admin/i })).toHaveCount(0);
		await expect(page.getByText(/No products yet/i)).toHaveCount(0);
		await testInfo.attach("dead-store-shop", {
			body: await page.screenshot(),
			contentType: "image/png",
		});

		restore();

		// Restored: the same product reads again, and so does the shop.
		const back = await page.goto(pdpPath);
		expect(back?.status(), `${pdpPath} after the restore`).toBe(200);
		const shop = await page.goto("/products");
		expect(shop?.status()).toBe(200);
	});
});
