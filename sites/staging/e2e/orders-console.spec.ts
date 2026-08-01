/**
 * The migrated Orders screen's gate (INC-20).
 *
 * `console-screens.spec.ts` generates the SMOKE spec for every registry entry —
 * that it renders 2xx, shows its heading, and has not hidden the Block Kit
 * sidebar group. This file is the acceptance on top of it: the five behaviours
 * the increment exists to deliver, each of which is invisible to a smoke spec
 * and to the 18 workerd sandbox suites alike (those are browser-blind, which is
 * why Playwright is the gate for React screens — ADR-0014, additively).
 *
 * The five, in the spec's own words:
 *   1. row click navigates to the order detail;
 *   2. the copy button copies the FULL id;
 *   3. the filter round-trips;
 *   4. the empty state is honest;
 *   5. the refund confirm still names the SHORT id — INC-01's contract must
 *      survive the migration, and this is the assertion that proves it did.
 *
 * ROWS ARE A PREREQUISITE, NOT AN ASSUMPTION. Four of the five need at least one
 * order to exist, so they call `skipWithoutOrders`, which skips loudly on a bare
 * stack and THROWS under `OTTA_E2E_REQUIRE_SITE=1`. A gate run therefore cannot
 * go green by asserting nothing.
 */
import type { Page } from "@playwright/test";
import {
	ADMIN_SHELL_TIMEOUT_MS,
	MIGRATED_SCREENS,
	REPO_ROOT,
	consoleScreenUrl,
	dismissWelcomeDialog,
	expect,
	skipWithoutOrders,
	test,
} from "./harness.js";

const ORDERS = MIGRATED_SCREENS.find((screen) => screen.path === "/orders");

/** Written at the outputDir ROOT rather than under the per-test directory:
 *  `preserveOutput: "failures-only"` sweeps the latter on a pass, and these
 *  shots are required evidence for a PASSING run (DIRECTOR-SPEC §4). §0.4's
 *  1440x2200 viewport comes from the project config; nothing here passes
 *  `fullPage`, which truncates these pages. */
const SHOT_DIR = `${REPO_ROOT}/node_modules/.playwright-artifacts`;

async function openOrders(page: Page): Promise<void> {
	await page.goto(consoleScreenUrl("/orders"));
	await expect(page.getByTestId("orders-intro")).toBeVisible({ timeout: ADMIN_SHELL_TIMEOUT_MS });
}

test.describe("the migrated Orders console", () => {
	// The admin shell's boot dominates every spec here; the per-test default
	// leaves too little after it for the assertions that follow.
	test.slow();

	test("is registered as a migrated screen", () => {
		// Server-free, and it is the coverage gate's own tripwire: if this entry
		// is ever removed, `console-screens.spec.ts` stops generating the smoke
		// spec and `site-config.test.ts` starts failing — but only if something
		// asserts the entry is the one this file was written for.
		expect(ORDERS, "Orders is not in MIGRATED_SCREENS").toBeDefined();
		expect(ORDERS?.increment).toBe("INC-20");
	});

	test("row click navigates to the order detail, and Back returns", async ({ adminPage }, info) => {
		await openOrders(adminPage);
		const links = adminPage.getByTestId("order-link");
		await skipWithoutOrders(info, await links.count());

		// The PRIMARY CELL is the link (DESIGNER §8) — not `<tr onClick>`, which
		// would leave no cell selectable for copy/paste. Clicking it must land on
		// the detail for THAT order.
		const first = links.first();
		const orderId = await first.getAttribute("data-order-id");
		expect(orderId, "the row link does not carry its order id").toBeTruthy();
		await first.click();

		await expect(adminPage.getByTestId("detail-heading")).toBeVisible();
		// The full id is obtainable on the detail (§1.3), and it is the id of the
		// row that was clicked — a detail for a different order would satisfy a
		// "did it navigate" assertion and be a serious bug.
		await expect(adminPage.getByTestId("detail-full-id")).toHaveText(orderId as string);

		// ...and the drill-in has a URL, which the Block Kit screen never had.
		expect(adminPage.url()).toContain(`order=${orderId as string}`);

		await adminPage.getByTestId("orders-back").click();
		await expect(adminPage.getByTestId("orders-table")).toBeVisible();
	});

	test("the row shows a SHORT prefix and the copy button copies the FULL id", async ({
		adminPage,
	}, info) => {
		await openOrders(adminPage);
		const links = adminPage.getByTestId("order-link");
		await skipWithoutOrders(info, await links.count());

		const first = links.first();
		const orderId = (await first.getAttribute("data-order-id")) as string;
		const shown = ((await first.textContent()) ?? "").trim();

		// §1.3: never the full id in a list row, never shorter than 4, and always
		// a prefix of the real thing — the property that lets an operator match a
		// row against a confirm dialog.
		expect(shown.length).toBeGreaterThanOrEqual(4);
		expect(shown.length).toBeLessThan(orderId.length);
		expect(orderId.startsWith(shown)).toBe(true);

		// The affordance Block Kit could not have at all. Clipboard permissions
		// are origin-gated and CI-dependent, so the assertion is on what the
		// button is WIRED to copy plus its acknowledgement — a copy button that
		// silently does nothing is the failure this catches either way.
		const copy = adminPage.getByTestId("copy-order-id").first();
		await expect(copy).toHaveAttribute("data-full-id", orderId);
		await expect(copy).toHaveAttribute("aria-label", `Copy full order id ${orderId}`);
		await copy.click();
		await expect(copy).not.toHaveText("Copy");
	});

	test("the Period filter round-trips and can be cleared", async ({ adminPage }) => {
		await openOrders(adminPage);
		await adminPage.getByTestId("orders-filters").getByRole("group").first().isVisible();

		// The filter panel is a native <details>; open it before touching a field.
		const panel = adminPage.getByTestId("orders-filters");
		await panel.locator("summary").click();

		// The vocabulary comes from the plugin, so these are literally the Block
		// Kit screen's own options — asserting the labels here is what pins that
		// the two screens offer the same period filter.
		const period = adminPage.getByTestId("filter-period");
		await expect(period.locator("option")).toHaveText([
			"Any time",
			"Last 7 days",
			"Last 30 days",
			"Last 90 days",
			"Custom…",
		]);

		await period.selectOption({ label: "Last 30 days" });
		await adminPage.getByTestId("apply-filters").click();

		// It round-trips: the applied filter is stated back, and the panel's own
		// active count agrees with it.
		await expect(adminPage.getByTestId("orders-filter-summary")).toContainText(
			"period: Last 30 days",
		);
		await expect(panel.locator("summary")).toContainText("(1 active)");

		await adminPage.getByTestId("clear-filters").click();
		await expect(adminPage.getByTestId("orders-filter-summary")).toHaveCount(0);
	});

	test("a filter that matches nothing says so, and offers the way back", async ({ adminPage }) => {
		await openOrders(adminPage);
		await adminPage.getByTestId("orders-filters").locator("summary").click();

		// A search no order can match. The empty state must be the FILTERED one —
		// "no orders yet" here would tell an operator their store is empty.
		await adminPage.getByTestId("filter-search").fill("zzz-no-such-order-zzz");
		await adminPage.getByTestId("apply-filters").click();

		const empty = adminPage.getByTestId("orders-no-match");
		await expect(empty).toBeVisible();
		await expect(empty).toContainText("No orders match these filters");
		await expect(adminPage.getByTestId("orders-empty")).toHaveCount(0);

		// ...and the way out is attached to it.
		await empty.getByRole("button", { name: "Clear filters" }).click();
		await expect(empty).toHaveCount(0);
	});

	test("the refund confirm names the SHORT id (INC-01's contract survives)", async ({
		adminPage,
	}, info) => {
		await openOrders(adminPage);
		const links = adminPage.getByTestId("order-link");
		await skipWithoutOrders(info, await links.count());

		// Find an order with something left to refund. Most seeded orders have
		// nothing captured; walking the first few pages of rows is cheaper and
		// more honest than seeding a special one here.
		const count = Math.min(await links.count(), 12);
		let found = false;
		for (let index = 0; index < count; index++) {
			await openOrders(adminPage);
			const link = adminPage.getByTestId("order-link").nth(index);
			const orderId = (await link.getAttribute("data-order-id")) as string;
			await link.click();
			await expect(adminPage.getByTestId("detail-heading")).toBeVisible();
			await adminPage.getByTestId("tab-money").click();

			const refundFull = adminPage.getByTestId("refund-full");
			if ((await refundFull.count()) === 0) continue;

			await refundFull.click();
			const text = adminPage.getByTestId("otta-confirm-text");
			await expect(text).toBeVisible();

			// THE ASSERTION. D4/§1.3: the confirm names the order FIRST, by an
			// 8-character prefix — never the full uuid, and never nothing at all.
			// Amount and buyer are the two attributes a repeat customer's orders
			// share, so a dialog naming only those cannot tell the operator which
			// order the money is about to leave.
			const body = (await text.textContent()) ?? "";
			expect(body).toContain(`Order #${orderId.slice(0, 8)}`);
			expect(body).not.toContain(orderId);
			expect(body.length).toBeLessThanOrEqual(200);

			// Nothing is refunded by this spec: deny, and confirm the dialog shut.
			await adminPage.getByTestId("otta-confirm-deny").click();
			await expect(text).toBeHidden();
			found = true;
			break;
		}
		if (!found) {
			await skipWithoutOrders(info, 0);
		}
	});

	test("captures the list, the detail and a focus state", async ({ adminPage }, testInfo) => {
		await openOrders(adminPage);
		await dismissWelcomeDialog(adminPage);

		const listShot = `${SHOT_DIR}/orders-console-list-1440x2200.png`;
		await adminPage.screenshot({ path: listShot });
		await testInfo.attach("orders-console-list-1440x2200", {
			path: listShot,
			contentType: "image/png",
		});

		// A11y: every interactive element takes a visible ring on keyboard
		// arrival. The shot is the DoD's evidence for it; `:focus-visible` (not
		// `:focus`) is why a Tab produces one and a click does not.
		await adminPage.keyboard.press("Tab");
		await adminPage.keyboard.press("Tab");
		const focusShot = `${SHOT_DIR}/orders-console-focus-1440x2200.png`;
		await adminPage.screenshot({ path: focusShot });
		await testInfo.attach("orders-console-focus-1440x2200", {
			path: focusShot,
			contentType: "image/png",
		});

		const links = adminPage.getByTestId("order-link");
		if ((await links.count()) === 0) return;
		await links.first().click();
		await expect(adminPage.getByTestId("detail-heading")).toBeVisible();
		const detailShot = `${SHOT_DIR}/orders-console-detail-1440x2200.png`;
		await adminPage.screenshot({ path: detailShot });
		await testInfo.attach("orders-console-detail-1440x2200", {
			path: detailShot,
			contentType: "image/png",
		});
	});

	test("no React error or warning is logged on the migrated screen", async ({ adminPage }) => {
		// `PM P2-1` / `EVIDENCE §4.6`: the Block Kit screen logged a
		// `ComboboxList` duplicate-key error, and it was PICKER-ONLY — deleting
		// the picker deletes it. This is the assertion that the migration did not
		// bring it along, or introduce a replacement.
		const problems: string[] = [];
		adminPage.on("console", (message) => {
			if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
		});
		await openOrders(adminPage);
		const links = adminPage.getByTestId("order-link");
		if ((await links.count()) > 0) {
			await links.first().click();
			await expect(adminPage.getByTestId("detail-heading")).toBeVisible();
		}
		// React's own diagnostics only. Vite's dev server, the admin shell and
		// EmDash itself log plenty that this increment does not own, so the filter
		// names React rather than asserting a silent console.
		const reactProblems = problems.filter(
			(text) =>
				/Warning:|each child in a list|unique "key"|React/i.test(text) && !/vite/i.test(text),
		);
		expect(reactProblems, `React logged: ${reactProblems.join(" | ")}`).toEqual([]);
	});
});
