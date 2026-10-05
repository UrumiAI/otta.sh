/**
 * The e2e run's one-time setup: WARM the dev server, and (opt-in) SEED it
 * (issue #378).
 *
 * WARM-UP, ALWAYS, WHEN A SITE IS UP. On a cold `astro dev` the first request
 * to each route compiles it, and the admin console's first load compiles
 * `PluginRegistry.js` (7.94 MB raw, see `ADMIN_SHELL_TIMEOUT_MS`). The first
 * console spec of a run paid for all of that inside its own timeout and could
 * time out on a server that was merely cold. So the routes are hit here first,
 * until each answers, and the console is loaded once in a real browser, so the
 * module graph the specs need is compiled before the first one starts. Every
 * wait is bounded (`WARM_UP_BUDGET_MS`): a server that never answers fails here,
 * by name, rather than as a mysterious first-spec timeout.
 *
 * SEED, UNDER `OTTA_E2E_SEED=1`. A fresh stack has no content, no prices and no
 * orders, and the specs that need rows skip (or, under
 * `OTTA_E2E_REQUIRE_SITE=1`, fail) without them. With the flag set, this applies
 * the site's CMS seed once (`/_emdash/api/setup/dev-bypass`, which skips
 * anything already there), prices the demo catalog (`seed-demo-commerce.ts`)
 * and places paid orders (`seed-e2e-orders.ts`). All three are safe to re-run,
 * so a second run against the same stack changes nothing. CI sets the flag; a
 * local run against a stack you care about need not.
 *
 * NOTHING HAPPENS WITHOUT A SITE. A bare `pnpm test:e2e` runs the server-free
 * gates, so with nothing listening setup returns at once, and with another
 * worktree's server on the port it returns after the first answer; the
 * per-screen specs then skip (or fail) as before.
 */
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
	cmsAuthHeaders,
	demoRows,
	fetchCmsProducts,
	seededProductSlugs,
	seedOneProduct,
} from "../scripts/seed-demo-commerce.js";
import {
	DEFAULT_PAID_ORDERS,
	E2E_WEBHOOK_SECRET,
	seedPaidOrders,
} from "../scripts/seed-e2e-orders.js";
import {
	ADMIN_BASE_PATH,
	consoleScreenUrl,
	DEV_BYPASS_SIGNIN_PATH,
	dismissWelcomeDialog,
	E2E_BASE_URL,
	E2E_REQUIRES_SITE,
	E2E_SEEDS,
	siteIsUp,
} from "./harness.js";

/** The whole warm-up's ceiling. A cold dev server on a small machine takes
 *  well under this to compile the admin graph (measured: 5–25 s per fresh
 *  context once compiled, longer the first time); a server that is still not
 *  answering after it is broken, not slow. */
export const WARM_UP_BUDGET_MS = 240_000;

/** The first-login greeting's dialog name, and how long to give it to open
 *  after the shell boots before concluding this account was already greeted. */
const WELCOME_DIALOG = /Welcome to EmDash/i;
const WELCOME_WAIT_MS = 10_000;

/** One console warm-up attempt: a navigation plus the wait for the screen. A
 *  first compile of the admin graph fits well inside it; a page that has not
 *  rendered by then is a dead tab, and the next attempt navigates afresh. */
const CONSOLE_ATTEMPT_MS = 90_000;

/** The routes a run touches first, in the order they are first touched: the
 *  storefront, then the admin shell. */
export const WARM_UP_PATHS = ["/", "/products", "/checkout", ADMIN_BASE_PATH] as const;

/** Poll `path` until it answers below 500, or the deadline passes. */
async function untilAnswers(path: string, deadline: number): Promise<void> {
	let last = "no answer";
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${E2E_BASE_URL}${path}`, {
				redirect: "manual",
				signal: AbortSignal.timeout(Math.max(1_000, Math.min(60_000, deadline - Date.now()))),
			});
			if (res.status < 500) return;
			last = `HTTP ${String(res.status)}`;
		} catch (err) {
			last = err instanceof Error ? err.message : String(err);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`warm-up: ${E2E_BASE_URL}${path} did not answer within the budget (${last}).`);
}

/** Load the Orders console once in a browser, so its module graph is compiled
 *  before the first spec opens it. */
async function warmConsole(deadline: number): Promise<void> {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.goto(`${E2E_BASE_URL}${DEV_BYPASS_SIGNIN_PATH}`, {
			timeout: Math.max(1_000, deadline - Date.now()),
		});
		// RETRIED, each attempt a fresh navigation. A cold server re-optimizes its
		// dependencies on the admin's first load ("optimized dependencies changed.
		// reloading"), and a request caught mid-swap can fail in the workerd runner
		// ("Network connection lost"), leaving a page that will never render. One
		// long wait on that page spends the whole budget on a dead tab (measured
		// under heavy machine load: the single wait timed out after 214 s with the
		// server healthy); a new navigation picks up the re-optimized graph.
		let lastError: unknown = new Error(
			"warm-up: the budget ran out before the console was loaded.",
		);
		while (Date.now() < deadline) {
			// One attempt's goto AND wait share its budget, and no attempt outlives
			// the overall deadline.
			const attemptEnds = Math.min(Date.now() + CONSOLE_ATTEMPT_MS, deadline);
			const left = (): number => Math.max(1_000, attemptEnds - Date.now());
			try {
				await page.goto(`${E2E_BASE_URL}${consoleScreenUrl("/orders")}`, { timeout: left() });
				await page.getByTestId("orders-intro").waitFor({ timeout: left() });
				lastError = undefined;
				break;
			} catch (err) {
				lastError = err;
				// A refused or instantly failing navigation must not spin.
				await new Promise((resolve) => setTimeout(resolve, 1_500));
			}
		}
		if (lastError !== undefined) throw lastError;
		// A FRESH stack's dev admin is greeted once with a modal that opens a moment
		// after the shell boots and intercepts every click until dismissed. The
		// dismissal is stored server-side, so doing it here once spares every spec
		// the race (measured: on a fresh .wrangler state the first run's Orders
		// specs timed out clicking rows under the modal).
		const greeting = page.getByRole("dialog", { name: WELCOME_DIALOG });
		const greeted = await greeting
			.waitFor({ timeout: WELCOME_WAIT_MS })
			.then(() => true)
			.catch(() => false);
		if (greeted) await dismissWelcomeDialog(page);
	} finally {
		await browser.close();
	}
}

/** Apply the CMS seed (signs in as the dev admin too). `onConflict: "skip"` on
 *  em-dash's side makes it a no-op for anything already there. */
async function applyCmsSeed(): Promise<void> {
	const res = await fetch(`${E2E_BASE_URL}/_emdash/api/setup/dev-bypass`, { redirect: "manual" });
	if (res.status >= 400) {
		throw new Error(`seed: the CMS seed (setup dev-bypass) answered HTTP ${String(res.status)}.`);
	}
}

/** Price and stock the demo catalog — `seed-demo-commerce.ts`'s own steps. A
 *  STRANDED product (priced but inactive, or at zero stock) fails the setup:
 *  the specs would otherwise skip with a message that sends the reader to the
 *  wrong place. */
async function priceCatalog(): Promise<void> {
	const authHeaders = await cmsAuthHeaders(E2E_BASE_URL);
	// `fileURLToPath`, not `.pathname`: the latter stays percent-encoded, so a
	// checkout path with a space or a non-ASCII character would not be found.
	const seedPath = fileURLToPath(new URL("../seed/seed.json", import.meta.url));
	const rows = demoRows(
		seededProductSlugs(seedPath),
		await fetchCmsProducts(E2E_BASE_URL, authHeaders),
	);
	for (const row of rows) {
		const outcome = await seedOneProduct(row, { siteUrl: E2E_BASE_URL, authHeaders });
		if (outcome.kind === "skipped-inactive" || outcome.kind === "skipped-unstocked") {
			throw new Error(`seed: ${row.slug} is ${outcome.reason}, so it cannot be bought.`);
		}
	}
}

/**
 * Is ANYTHING listening at `E2E_BASE_URL`? Only a refused connection counts as
 * "no": a cold dev server accepts the connection and then takes far longer than
 * `siteIsUp()`'s 3 s probe to answer its first request, which is exactly the
 * case the warm-up exists for. (Measured: on a fresh `.wrangler` state the first
 * `/` took longer than that, `siteIsUp()` said "no site", setup returned, and
 * every spec then failed under OTTA_E2E_REQUIRE_SITE=1.)
 */
async function somethingListens(): Promise<boolean> {
	try {
		await fetch(E2E_BASE_URL, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
		return true;
	} catch (err) {
		// A timeout is a server busy compiling, not an absent one.
		return err instanceof DOMException && err.name === "TimeoutError";
	}
}

export default async function globalSetup(): Promise<void> {
	if (!(await somethingListens())) return;
	const deadline = Date.now() + WARM_UP_BUDGET_MS;
	try {
		// Warm FIRST, then ask whose server it is: the ownership probe has a short
		// timeout of its own, and a cold server would fail it.
		await untilAnswers("/", deadline);
		if (!(await siteIsUp())) {
			// Something answers, but it is not this worktree's dev server. A run
			// that asked for seeding or for a site must not go on to skip (or fail)
			// spec by spec with a message about the wrong cause.
			if (E2E_SEEDS || E2E_REQUIRES_SITE) {
				throw new Error(
					`setup: the server at ${E2E_BASE_URL} answers but is not this worktree's dev ` +
						`server (it refused the /@fs ownership probe). Stop it or point ` +
						`OTTA_E2E_BASE_URL at this worktree's server; OTTA_E2E_SEED=1 / ` +
						`OTTA_E2E_REQUIRE_SITE=1 will not seed or grade another tree.`,
				);
			}
			return;
		}
		for (const path of WARM_UP_PATHS) await untilAnswers(path, deadline);
		if (E2E_SEEDS) {
			await applyCmsSeed();
			await priceCatalog();
			const placed = await seedPaidOrders(
				{
					siteUrl: E2E_BASE_URL,
					authHeaders: await cmsAuthHeaders(E2E_BASE_URL),
					webhookSecret: E2E_WEBHOOK_SECRET,
				},
				DEFAULT_PAID_ORDERS,
			);
			console.info(`[e2e] seeded: catalog priced, ${String(placed)} paid order(s) placed.`);
		}
		await warmConsole(deadline);
	} catch (err) {
		// A seed failure is always loud: OTTA_E2E_SEED=1 asked for rows, and
		// running on without them would only re-report the failure as skips.
		// A warm-up failure is loud under OTTA_E2E_REQUIRE_SITE=1; otherwise the
		// specs still run, with the time they would have had anyway.
		if (E2E_SEEDS || E2E_REQUIRES_SITE) throw err;
		console.warn(`[e2e] warm-up incomplete, continuing: ${String(err)}`);
	}
}
