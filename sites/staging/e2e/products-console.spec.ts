/**
 * The migrated Pricing & inventory screen's gate (INC-21).
 *
 * `console-screens.spec.ts` generates the SMOKE spec for every registry entry —
 * that it renders 2xx, shows its heading, and has not hidden the Block Kit
 * sidebar group. This file is the acceptance on top of it: the behaviours the
 * increment exists to deliver, each of which is invisible to a smoke spec and to
 * the workerd sandbox suites alike (those are browser-blind, which is why
 * Playwright is the gate for React screens — ADR-0014, additively).
 *
 * The seven, in the spec's own words:
 *   1. row click navigates to the product detail, and Back returns;
 *   2. the SKU renders IN FULL — the identity ruling — and the copy button
 *      copies it;
 *   3. the filter round-trips and can be cleared;
 *   4. "Low stock only" behaves as a PAGE-SCOPED filter and says so;
 *   5. the empty state is honest;
 *   6. **there is no Title field and no Status field** (G2 / ADR-0013) — the
 *      Block Kit screen enforces this in the type system, and the React screen
 *      does not, which is exactly why it is asserted here in the browser rather
 *      than only in a unit test;
 *   7. the two adjacent stock forms (PM §E2) both raise a confirm on a valid
 *      quantity — restock is gated the same way removal is — but at different
 *      weight: removal's is destructive-styled and says it cannot be undone by
 *      restocking, restock's is neutral and reversible by a later removal.
 *
 * ROWS ARE A PREREQUISITE, NOT AN ASSUMPTION. The row-dependent specs call
 * `skipWithoutProducts`, which skips loudly on a bare stack and THROWS under
 * `OTTA_E2E_REQUIRE_SITE=1`. A gate run therefore cannot go green by asserting
 * nothing.
 */
import type { Locator, Page } from "@playwright/test";
import {
	ADMIN_SHELL_TIMEOUT_MS,
	MIGRATED_SCREENS,
	REPO_ROOT,
	consoleScreenUrl,
	dismissWelcomeDialog,
	expect,
	skipWithoutProducts,
	skipWithoutSku,
	skipWithoutStockableProduct,
	test,
} from "./harness.js";

const PRODUCTS = MIGRATED_SCREENS.find((screen) => screen.path === "/products");

/** Written at the outputDir ROOT rather than under the per-test directory:
 *  `preserveOutput: "failures-only"` sweeps the latter on a pass, and these
 *  shots are required evidence for a PASSING run (DIRECTOR-SPEC §4). */
const SHOT_DIR = `${REPO_ROOT}/node_modules/.playwright-artifacts`;

async function openProducts(page: Page): Promise<void> {
	await page.goto(consoleScreenUrl("/products"));
	await expect(page.getByTestId("products-intro")).toBeVisible({ timeout: ADMIN_SHELL_TIMEOUT_MS });
}

/**
 * Open the first product whose Stock tab renders the two movement forms, and
 * EXPAND both.
 *
 * TWO THINGS A NAIVE VERSION GETS WRONG, and this run found both:
 *
 *  - A product with no SKU, or a SKU with no inventory record, renders a
 *    one-line explanation instead of the forms — by design (D-7) — so a stock
 *    spec has to LOOK for one that works rather than assume the first row does.
 *  - Both groups are collapsed `<details>` on arrival, exactly as their Block
 *    Kit accordions are (`default_open: false` for anything destructive, D-5).
 *    A field inside a closed `<details>` is IN THE DOM AND NOT VISIBLE, so a
 *    `count() > 0` check passes and the `fill()` after it hangs until timeout.
 *    Presence is not the same question as reachability.
 */
async function openStockableProduct(page: Page, limit = 6): Promise<boolean> {
	const count = Math.min(await page.getByTestId("product-link").count(), limit);
	for (let index = 0; index < count; index++) {
		await openProducts(page);
		await page.getByTestId("product-link").nth(index).click();
		await expect(page.getByTestId("detail-heading")).toBeVisible();
		await page.getByTestId("tab-stock").click();
		if ((await page.getByTestId("restock-qty").count()) === 0) continue;
		for (const testId of ["stock-add", "stock-remove"]) {
			await page.getByTestId(testId).locator("summary").click();
		}
		await expect(page.getByTestId("restock-qty")).toBeVisible();
		await expect(page.getByTestId("remove-qty")).toBeVisible();
		return true;
	}
	return false;
}

/**
 * Whichever `ConfirmDialog` is currently shown modally — NOT "the stock
 * confirm" specifically, only whatever happens to be open, so a caller must
 * not reach for this by name alone. Matches the discriminator this repo
 * already uses for the same dialog pair in
 * `packages/admin-react/test/console-chrome-dom.test.tsx`'s `openDialog`.
 *
 * `ConfirmDialog` is a shared component with one testid per part, and the
 * detail screen now mounts it TWICE at once: the stock confirm this spec
 * drives, and `detail-leave-confirm`'s own instance, kept permanently mounted
 * (never unmounted) so a tab switch cannot lose a typed price. A bare
 * `getByTestId("otta-confirm-text")` therefore resolves to two nodes and
 * Playwright's strict mode rejects it, visible or not.
 *
 * SAFE HERE, NOT SAFE BY CONSTRUCTION. `product-detail.tsx` says the two
 * dialogs are never open together, but Back (`products-back`) is not the
 * leave-confirm's only trigger — a browser Back also bumps `leavePrompt`
 * (`product-detail.tsx:524-529`, via `products-screen.tsx`'s `popstate`
 * handler), which does not require the modal Back button at all. That path is
 * gated on `unsaved.current`, which tracks only identity/price/shipping
 * dirtiness (`leaveNeedsConfirm`) — and this spec dirties none of them, so for
 * THIS spec the leave-confirm never opens. A future spec that dirties one of
 * those sections and then calls this helper would get whichever dialog is
 * open, possibly the wrong one under the right-sounding name — check that the
 * same contingency still holds before reusing it, rather than trusting the
 * name.
 */
function openConfirmDialog(page: Page): Locator {
	return page.locator('dialog[data-testid="otta-confirm"][open]');
}

test.describe("the migrated Pricing & inventory console", () => {
	// The admin shell's boot dominates every spec here.
	test.slow();

	test("is registered as a migrated screen", () => {
		// Server-free, and it is the coverage gate's own tripwire: if this entry is
		// removed, `console-screens.spec.ts` stops generating the smoke spec and
		// `site-config.test.ts` starts failing — but only if something asserts the
		// entry is the one this file was written for.
		expect(PRODUCTS, "Pricing & inventory is not in MIGRATED_SCREENS").toBeDefined();
		expect(PRODUCTS?.increment).toBe("INC-21");
	});

	test("row click navigates to the product detail, and Back returns", async ({
		adminPage,
	}, info) => {
		await openProducts(adminPage);
		const links = adminPage.getByTestId("product-link");
		await skipWithoutProducts(info, await links.count());

		// DESIGNER §8: the PRIMARY CELL is the link — the title, which is the
		// human handle and the first column of the screen being migrated. Not
		// `<tr onClick>`, which would leave no cell selectable and make the SKU
		// beside it uncopyable by hand.
		const first = links.first();
		const productId = await first.getAttribute("data-product-id");
		expect(productId, "the row link does not carry its product id").toBeTruthy();
		await first.click();

		await expect(adminPage.getByTestId("detail-heading")).toBeVisible();
		// ...and the drill-in has a URL, which the Block Kit screen never had.
		expect(adminPage.url()).toContain(`product=${productId as string}`);

		await adminPage.getByTestId("products-back").click();
		await expect(adminPage.getByTestId("products-table")).toBeVisible();
	});

	test("the SKU renders IN FULL and the copy button copies it", async ({ adminPage }, info) => {
		// THE IDENTITY RULING, asserted. §1.3's prefix rule governs OPAQUE ids and
		// says Orders is the only screen showing one. Here identity is the SKU — a
		// natural key, the thing low stock is reported by — which §1.3 exempts, so
		// it renders WHOLE and the React tier's contribution is the copy button
		// rather than a truncation. The product uuid is never rendered at all.
		await adminPage.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await openProducts(adminPage);
		const links = adminPage.getByTestId("product-link");
		await skipWithoutProducts(info, await links.count());

		const skus = adminPage.getByTestId("product-sku");
		if ((await skus.count()) === 0) {
			// Every product on this page is a "created but never priced" row. That is
			// a real state, not a failure — and it is NOT "no products", which is why
			// it gets its own message and its own fix.
			await skipWithoutSku(info);
			return;
		}
		const sku = ((await skus.first().textContent()) ?? "").trim();
		expect(sku.length).toBeGreaterThan(0);
		expect(sku).not.toContain("…");

		const copy = adminPage.getByTestId("copy-sku").first();
		await expect(copy).toHaveAttribute("data-full-id", sku);
		await expect(copy).toHaveAttribute("aria-label", `Copy SKU ${sku}`);
		await copy.click();
		// ASSERT THE ACHIEVED STATE, not merely a changed one — the failure label
		// (`Press ⌘C`) is also "not Copy".
		await expect(copy).toHaveText("Copied");
		const written = await adminPage.evaluate(() => navigator.clipboard.readText());
		expect(written, "the clipboard does not hold the SKU").toBe(sku);

		// The row shows no uuid anywhere. The id is in the link's href and its data
		// attribute, which is what navigates — not what is read.
		const productId = (await links.first().getAttribute("data-product-id")) as string;
		const rowText = (await adminPage.getByTestId("products-row").first().textContent()) ?? "";
		expect(rowText).not.toContain(productId);
	});

	test("the Status filter round-trips and can be cleared", async ({ adminPage }) => {
		await openProducts(adminPage);
		const panel = adminPage.getByTestId("products-filters");
		await panel.locator("summary").click();

		// The vocabulary comes from the plugin, so these are literally the Block Kit
		// screen's own options — asserting the labels here is what pins that the two
		// screens offer the same filter.
		const status = adminPage.getByTestId("filter-status");
		await expect(status.locator("option")).toHaveText([
			"All statuses (live)",
			"Active",
			"Inactive",
			"Archived (deleted)",
		]);
		await expect(adminPage.getByTestId("filter-kind").locator("option")).toHaveText([
			"All kinds",
			"physical",
			"digital",
		]);

		await status.selectOption({ label: "Active" });
		await adminPage.getByTestId("apply-filters").click();

		await expect(adminPage.getByTestId("products-filter-summary")).toContainText("status: true");
		await expect(panel.locator("summary")).toContainText("(1 active)");

		await adminPage.getByTestId("clear-filters").click();
		await expect(adminPage.getByTestId("products-filter-summary")).toHaveCount(0);
	});

	test("`Low stock only` states the WHOLE CATALOG", async ({ adminPage }) => {
		await openProducts(adminPage);
		const panel = adminPage.getByTestId("products-filters");
		await panel.locator("summary").click();

		// The control's own description says where the threshold lives and that the
		// filter reaches the whole catalog — a promise this screen keeps, because
		// the threshold is a predicate the SERVICE applies to the query rather
		// than a narrowing of the rows one page happened to fetch.
		await expect(panel).toContainText(
			"Show every product in the catalog at or below the low-stock threshold (set the threshold on Settings).",
		);
		await adminPage.getByTestId("filter-low-stock").check();
		await adminPage.getByTestId("apply-filters").click();

		await expect(adminPage.getByTestId("products-filter-summary")).toContainText("stock: low only");

		// Whatever the seeded catalog holds, the screen must land in a state whose
		// words match what the SERVICE was asked: rows counted as low-stock ones,
		// or the whole-catalog zero state. What it must never do is hedge back to
		// the page — that qualifier described a narrowing this screen no longer
		// does — or claim the catalog is empty when it is merely well stocked.
		//
		// ASSERTED ON THE SETTLED STATE, via `toPass`. The filter summary is
		// derived from the applied filter and updates SYNCHRONOUSLY on click, while
		// the table still shows the previous page until the fetch resolves — so a
		// single-shot read can catch "stock: low only" above rows that are not low,
		// under the count line that described them. (That window is not introduced
		// here: the React Orders list has the same shape, and this spec's job is to
		// assert what the screen SETTLES on, not to police a frame of it.)
		const intro = adminPage.getByTestId("products-intro");
		const scan = adminPage.getByTestId("products-scan-note");
		const empty = adminPage.getByTestId("products-no-match");
		// A threshold the plugin could not read sends NO predicate, so the page is
		// unfiltered and its ordinary words are the honest ones — the banner says
		// so. That is a different state, not a softer version of this one, and it
		// gets the assertions it earns rather than weakening the ones below.
		const degraded = adminPage.getByTestId("products-stock-degraded");
		await expect(async () => {
			const rows = await adminPage.getByTestId("products-row").count();
			const unfiltered = (await degraded.count()) > 0;
			if (rows === 0) {
				// Either the whole-catalog zero state, or the scan note that keeps
				// `Load more` alive — never the whole-catalog "No products yet".
				const scanned = await scan.count();
				expect(scanned + (await empty.count())).toBeGreaterThan(0);
				const shown = (await (scanned > 0 ? scan : empty).textContent()) ?? "";
				if (unfiltered) {
					expect(shown).toContain("No products match these filters");
				} else if (scanned > 0) {
					expect(shown).toContain(
						"No products are at or below the low-stock threshold. Load more scans further.",
					);
				} else {
					expect(shown).toContain("No products are low on stock");
					expect(shown).toContain("Every product in the catalog is above the low-stock threshold.");
				}
			} else {
				// THE COUNT NAMES WHAT WAS COUNTED. The predicate ran server-side, so
				// the rows are the low-stock ones the service selected and the count
				// says so; the page-scoped hedge would now understate a real answer.
				const counted = (await intro.textContent()) ?? "";
				if (unfiltered) {
					expect(counted).not.toContain("low-stock product");
				} else {
					expect(counted).toContain("low-stock product");
				}
			}
		}).toPass({ timeout: 15_000 });

		// Whichever branch it landed in, the whole-collection claim is never made.
		expect((await adminPage.locator("body").textContent()) ?? "").not.toContain("No products yet");
		if ((await scan.count()) > 0) {
			// The whole point of the scan note: the button it talks about is there.
			await expect(adminPage.getByTestId("products-load-more")).toBeVisible();
		}

		await adminPage.getByTestId("clear-filters").click();
		await expect(adminPage.getByTestId("products-filter-summary")).toHaveCount(0);
	});

	test("a filter that matches nothing says so, and offers the way back", async ({ adminPage }) => {
		await openProducts(adminPage);
		await adminPage.getByTestId("products-filters").locator("summary").click();

		// A search no product can match. The empty state must be the FILTERED one —
		// "No products yet" here would tell a merchant their catalog is empty.
		await adminPage.getByTestId("filter-search").fill("zzz-no-such-product-zzz");
		await adminPage.getByTestId("apply-filters").click();

		const empty = adminPage.getByTestId("products-no-match");
		await expect(empty).toBeVisible();
		await expect(empty).toContainText("No products match these filters");
		await expect(adminPage.getByTestId("products-empty")).toHaveCount(0);

		await empty.getByRole("button", { name: "Clear filters" }).click();
		await expect(empty).toHaveCount(0);
	});

	test("there is NO Title field and NO Status field (G2 / ADR-0013)", async ({
		adminPage,
	}, info) => {
		// THE ASSERTION THIS SPEC EXISTS FOR. On the Block Kit screen the rule is
		// structural — `ProductEditWire` has no `title` or `active` member, so a
		// form field for either does not compile. The React screen posts a payload
		// of plain strings and gets no such compile error, so the absence is
		// asserted in the browser, on the rendered DOM.
		await openProducts(adminPage);
		const links = adminPage.getByTestId("product-link");
		await skipWithoutProducts(info, await links.count());
		await links.first().click();
		await expect(adminPage.getByTestId("detail-heading")).toBeVisible();

		// Open every editable group so a field hidden inside a collapsed one cannot
		// escape the assertion.
		for (const testId of ["edit-identity", "edit-price", "edit-shipping"]) {
			const group = adminPage.getByTestId(testId);
			if ((await group.count()) === 0) continue;
			await group.locator("summary").click();
		}

		// No control whose label or accessible name is Title or Status.
		const editable = adminPage.locator(
			'[role="tabpanel"] input:not([type="checkbox"]), [role="tabpanel"] select, [role="tabpanel"] textarea',
		);
		const labels: string[] = [];
		for (let index = 0; index < (await editable.count()); index++) {
			const control = editable.nth(index);
			const label = (await control.evaluate((el) => el.closest("label")?.textContent ?? "")).trim();
			labels.push(label);
		}
		expect(labels.length, "the detail rendered no editable fields at all").toBeGreaterThan(0);
		for (const [index, label] of labels.entries()) {
			// EVERY LABEL IS NON-EMPTY FIRST. Without this the loop is vacuous per
			// row rather than in total: a control whose `<label>` this walk failed to
			// find yields `""`, which satisfies both `not.toMatch` assertions below
			// and reports a pass for a field nobody looked at. The count check above
			// does not catch it — a screen of unlabelled inputs would sail through.
			expect(label, `editable field #${String(index)} has no label to check`).not.toBe("");
			expect(label, `an editable field is labelled ${label}`).not.toMatch(/^Title/i);
			expect(label, `an editable field is labelled ${label}`).not.toMatch(/^Status/i);
		}

		// ...and Status is still PRESENT as text, with its owner named. Read-only is
		// the requirement; invisible is not.
		await expect(adminPage.getByTestId("detail-identity")).toContainText("Status (set in the CMS)");
	});

	test("the two adjacent stock forms differ: destructive removal, neutral restock (PM §E2)", async ({
		adminPage,
	}, info) => {
		await openProducts(adminPage);
		await skipWithoutProducts(info, await adminPage.getByTestId("product-link").count());
		if (!(await openStockableProduct(adminPage))) {
			await skipWithoutStockableProduct(info);
			return;
		}

		// Both forms are present, adjacent, and take the same input — which is
		// exactly why the difference between them has to be legible.
		await expect(adminPage.getByTestId("stock-add")).toBeVisible();
		await expect(adminPage.getByTestId("stock-remove")).toBeVisible();
		await expect(adminPage.getByTestId("stock-remove")).toContainText(
			"cannot be undone by restocking",
		);

		// A bad quantity is refused INLINE, before anything is sent, on both forms.
		await adminPage.getByTestId("remove-qty").fill("nope");
		await adminPage.getByTestId("remove-submit").click();
		await expect(adminPage.getByTestId("remove-qty-error")).toContainText("Nothing was changed");
		await expect(openConfirmDialog(adminPage).getByTestId("otta-confirm-text")).toBeHidden();

		// A REMOVAL raises a confirm naming the concrete quantity and its
		// consequence, weighted destructive: the bold font-weight on the button
		// that does it. Nothing is removed by this spec: deny, and confirm it
		// shut.
		await adminPage.getByTestId("remove-qty").fill("1");
		await adminPage.getByTestId("remove-submit").click();
		const confirmText = openConfirmDialog(adminPage).getByTestId("otta-confirm-text");
		await expect(confirmText).toBeVisible();
		await expect(openConfirmDialog(adminPage).getByTestId("otta-confirm-title")).toHaveText(
			"Remove 1 unit?",
		);
		await expect(confirmText).toContainText("Remove 1 unit from stock?");
		await expect(confirmText).toContainText("cannot be undone by restocking");
		await expect(openConfirmDialog(adminPage).getByTestId("otta-confirm-yes")).toHaveCSS(
			"font-weight",
			"600",
		);
		await openConfirmDialog(adminPage).getByTestId("otta-confirm-deny").click();
		await expect(confirmText).toBeHidden();

		// A bad quantity is refused INLINE on the add form too, before any confirm
		// is raised.
		await adminPage.getByTestId("restock-qty").fill("0");
		await adminPage.getByTestId("restock-submit").click();
		await expect(adminPage.getByTestId("restock-qty-error")).toBeVisible();
		await expect(confirmText).toBeHidden();

		// A valid RESTOCK raises a confirm too — gated the same way removal is —
		// but at neutral weight, never the bold font-weight: adding stock is
		// undoable, and dressing it as destruction would teach an operator to read
		// past the weight on the confirm that is not. Nothing is added by this
		// spec: deny, and confirm it shut.
		await adminPage.getByTestId("restock-qty").fill("5");
		await adminPage.getByTestId("restock-submit").click();
		await expect(confirmText).toBeVisible();
		await expect(openConfirmDialog(adminPage).getByTestId("otta-confirm-title")).toHaveText(
			"Add 5 units?",
		);
		await expect(confirmText).toContainText("Add 5 units to");
		await expect(confirmText).toContainText("sell them immediately");
		await expect(openConfirmDialog(adminPage).getByTestId("otta-confirm-yes")).not.toHaveCSS(
			"font-weight",
			"600",
		);
		await openConfirmDialog(adminPage).getByTestId("otta-confirm-deny").click();
		await expect(confirmText).toBeHidden();
	});

	test("captures the list, the detail and a focus state", async ({ adminPage }, testInfo) => {
		await openProducts(adminPage);
		await dismissWelcomeDialog(adminPage);

		const listShot = `${SHOT_DIR}/products-console-list-1440x2200.png`;
		await adminPage.screenshot({ path: listShot });
		await testInfo.attach("products-console-list-1440x2200", {
			path: listShot,
			contentType: "image/png",
		});

		// A11y: every interactive element takes a visible ring on keyboard arrival.
		// The ring goes on a control THIS increment owns — the first cut of the
		// Orders equivalent pressed Tab twice from page load and photographed the
		// admin shell's own chrome — and it is asserted before it is photographed,
		// so a missing one fails the spec rather than producing a screenshot nobody
		// looks at closely.
		const focusTarget = (await adminPage.getByTestId("product-link").count())
			? adminPage.getByTestId("product-link").first()
			: adminPage.getByTestId("products-filters").locator("summary").first();
		await focusTarget.focus();
		await expect(focusTarget).toBeFocused();
		const ringed = await focusTarget.evaluate((element) => element.matches(":focus-visible"));
		expect(ringed, "the focused console control has no :focus-visible ring").toBe(true);
		const focusShot = `${SHOT_DIR}/products-console-focus-1440x2200.png`;
		await adminPage.screenshot({ path: focusShot });
		await testInfo.attach("products-console-focus-1440x2200", {
			path: focusShot,
			contentType: "image/png",
		});

		const links = adminPage.getByTestId("product-link");
		if ((await links.count()) === 0) return;
		await links.first().click();
		await expect(adminPage.getByTestId("detail-heading")).toBeVisible();
		const detailShot = `${SHOT_DIR}/products-console-detail-1440x2200.png`;
		await adminPage.screenshot({ path: detailShot });
		await testInfo.attach("products-console-detail-1440x2200", {
			path: detailShot,
			contentType: "image/png",
		});

		await adminPage.getByTestId("tab-stock").click();
		await expect(adminPage.getByTestId("detail-stock")).toBeVisible();
		const stockShot = `${SHOT_DIR}/products-console-stock-1440x2200.png`;
		await adminPage.screenshot({ path: stockShot });
		await testInfo.attach("products-console-stock-1440x2200", {
			path: stockShot,
			contentType: "image/png",
		});
	});

	test("no React error or warning is logged on the migrated screen", async ({ adminPage }) => {
		// The Block Kit screen logged a `ComboboxList` duplicate-key error from its
		// `Open product` picker. Deleting the picker deletes it; this asserts the
		// migration did not bring it along, or introduce a replacement.
		const problems: string[] = [];
		adminPage.on("console", (message) => {
			if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
		});
		await openProducts(adminPage);
		const links = adminPage.getByTestId("product-link");
		if ((await links.count()) > 0) {
			await links.first().click();
			await expect(adminPage.getByTestId("detail-heading")).toBeVisible();
			await adminPage.getByTestId("tab-stock").click();
			await expect(adminPage.getByTestId("detail-stock")).toBeVisible();
		}
		// React's own diagnostics only. Vite's dev server, the admin shell and
		// EmDash itself log plenty this increment does not own.
		const reactProblems = problems.filter(
			(text) =>
				/Warning:|each child in a list|unique "key"|React/i.test(text) && !/vite/i.test(text),
		);
		expect(reactProblems, `React logged: ${reactProblems.join(" | ")}`).toEqual([]);
	});
});
