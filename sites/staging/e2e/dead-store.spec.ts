/**
 * #659 (follow-up to #653 / #140) — a dead content store answers 503 end to
 * end, against a real D1.
 *
 * `test/content-store.test.ts` proves the probe against better-sqlite3 and
 * `test/catalog-pages.test.ts` only regex-checks that the pages call it. Neither
 * renders a page against a database, and neither shows that D1 (workerd's
 * SQLite, behind emdash's Kysely dialect) rejects the probe the way plain
 * SQLite does. This spec does both: it renames `ec_products` in the dev
 * server's LOCAL D1 file, then asks for a product page and the shop.
 *
 * LOCAL ONLY, by construction. The table is renamed through the SQLite file
 * under this worktree's `sites/staging/.wrangler/state` — the state `astro dev`
 * runs on — so there is no binding name, no account and no `--remote` anywhere
 * to get wrong. The table is renamed back in `finally`, and a leftover from an
 * interrupted run is restored before anything else happens.
 *
 * It needs a seeded stack (a products table to rename); without one it skips,
 * or fails under `OTTA_E2E_REQUIRE_SITE=1`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { E2E_REQUIRES_SITE, REPO_ROOT, expect, skipWithoutSite, test } from "./harness.js";

const TABLE = "ec_products";
const PARKED = "ec_products_e2e_659_parked";
/** Miniflare keeps each local D1 database as one SQLite file in here. */
const D1_DIR = join(REPO_ROOT, "sites/staging/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

const tables = (db: Database.Database): Set<string> =>
	new Set(
		db
			.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => row.name),
	);

/** The local D1 file holding the content tables, opened; `undefined` if none. */
function openContentDb(): Database.Database | undefined {
	if (!existsSync(D1_DIR)) return undefined;
	for (const file of readdirSync(D1_DIR)) {
		if (!file.endsWith(".sqlite") || file === "metadata.sqlite") continue;
		const db = new Database(join(D1_DIR, file), { fileMustExist: true });
		const names = tables(db);
		if (names.has(TABLE) || names.has(PARKED)) return db;
		db.close();
	}
	return undefined;
}

function rename(db: Database.Database, from: string, to: string): void {
	db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
}

test.describe("a missing products table is an outage, not a missing product (#659)", () => {
	test.slow();

	test("the PDP answers 503 + Retry-After and the shop offers no 'Open the admin'", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		const db = openContentDb();
		if (db === undefined) {
			const how = `no local D1 file under ${D1_DIR} has a "${TABLE}" table — seed the stack (OTTA_E2E_SEED=1).`;
			if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
			testInfo.skip(true, how);
			return;
		}
		try {
			// An interrupted earlier run may have left the table parked.
			if (tables(db).has(PARKED) && !tables(db).has(TABLE)) rename(db, PARKED, TABLE);

			// Control, on a live store: an unknown address is a genuine 404, so the
			// 503 below is the missing table's doing and not every miss's.
			const miss = await page.goto("/products/no-such-product-659");
			expect(miss?.status()).toBe(404);
			expect(miss?.headers()["retry-after"]).toBeUndefined();

			rename(db, TABLE, PARKED);

			const pdp = await page.goto("/products/otta-tee");
			expect(pdp?.status(), "PDP with the products table gone").toBe(503);
			expect(pdp?.headers()["retry-after"]).toBe("60");

			const plp = await page.goto("/products");
			expect(plp?.status(), "shop page with the products table gone").toBe(503);
			expect(plp?.headers()["retry-after"]).toBe("60");
			await expect(page.getByRole("link", { name: /Open the admin/i })).toHaveCount(0);
			await expect(page.getByText(/No products yet/i)).toHaveCount(0);
			await testInfo.attach("dead-store-shop", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
		} finally {
			if (tables(db).has(PARKED)) rename(db, PARKED, TABLE);
			db.close();
		}

		// Restored: the shop reads again, so the run leaves the store as it found it.
		const back = await page.goto("/products");
		expect(back?.status()).toBe(200);
	});
});
