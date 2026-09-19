/**
 * The Pricing & inventory WRITE path, exercised INSIDE the workerd sandbox
 * (INC-R3).
 *
 * WHY A SANDBOX SUITE AND NOT A UNIT TEST. ADR-0006 Decision 1, reaffirmed by
 * ADR-0014 and again by ADR-0015: the workerd suites are the contract gate for
 * `@otta-sh/plugin`, and "a change that only works trusted is still broken". This
 * suite therefore drives the writes the way the React console does — one POST to
 * the plugin's single `admin` route, `type: "otta_console_act"`, an action id and
 * a FLAT payload — inside the isolate the plugin is specified to run in.
 *
 * WHAT IT REPLACES. `products-page.sandbox.test.ts` was 2,170 lines, and the bulk
 * of it asserted the retired Block Kit screen's RENDERING: block order, the table's
 * columns, the filter accordion, the drill-in picker's option labels, which
 * accordion `default_open` resolves to, the three `block_id`s the staged/refused
 * remove-stock group cycles through, the identity strip's shape and evenness, the
 * tombstone and no-SKU context lines, accordion-label budgets and their truncation.
 * None of that outlives the renderer. Everything asserting BEHAVIOUR moved here.
 *
 * THERE IS NO SERVICE BEHIND THESE WRITES ANY MORE (INC-D3a). The console's
 * clients come from `makeAdminClients(ctx)`, which composes the commerce adapters
 * straight over `ctx.storage` — so a save here edits a REAL product-commerce
 * document and a stock movement moves a REAL inventory count, both in the same
 * document store this file seeds through those same adapters. Every assertion that
 * used to read a recorded HTTP request is therefore gone: there is no PATCH body
 * to inspect, no POST url to match, and no token pair to forward —
 * `X-Internal-Token`/`X-Service-Token` authenticated a caller TO THE SERVICE and
 * ADR-0014 D3 deleted both with the deployment. What each write DID is read back
 * off the product row instead, which is the stronger statement: the old tests
 * proved a request was addressed correctly, these prove the row changed — and, for
 * every refusal, that it did not.
 *
 * THE FOUR INVARIANTS THIS SCREEN'S GATE IS MADE OF, each proven below:
 *
 *  1. **Money is integer minor units, and absent is not zero.** A price is STORED
 *     as `{amount, currency}` in minor units or not at all; a malformed one is
 *     refused BEFORE anything is written; a blank compare-at is an explicit `null`
 *     CLEAR and never a zero; a blank price leaves the stored price alone and
 *     never becomes zero.
 *  2. **The stale-watermark refusal (DA-3a), carried verbatim.** A stock removal
 *     re-reads live stock and refuses on a mismatch with NOTHING written — and an
 *     ABSENT watermark refuses fail-closed, with no re-read at all. A save carries
 *     `expectedUpdatedAt` and refuses without one rather than clobbering; with a
 *     stale one it is refused by the store's own compare-and-set.
 *  3. **Idempotency without a nonce, and the replay case.** Every key is derived
 *     from content plus the watermark the operator saw. THE KEY IS NO LONGER A
 *     STRING ANY TEST CAN SEE — it is an argument handed to a use-case in this
 *     process rather than a header on a wire — so it is proven by what it BUYS:
 *     a double-submit of one rendered form applies once and still reads `Saved`
 *     (a second, distinct write against that now-stale watermark is refused as
 *     stale instead), and two deliberate movements taken against two different
 *     observed counts both apply.
 *  4. **The verified sparse edit.** Each of the three split saves writes its own
 *     fields and leaves every other stored value untouched, and `title`/`active`
 *     can never be written at all (G2 / ADR-0013) however hostile the payload is —
 *     neither `ProductEditWire` nor `UpdateProductCommerceFieldsInput` has a
 *     member for either.
 *
 * WHAT IS NOT TESTED HERE, AND WHY THAT IS NOT A SILENT GAP.
 *
 * `products:remove-stock-review` — DA-3 state 1 → state 2 — is not ported. It
 * staged a quantity server-side so a SECOND RENDER could draw a confirm button;
 * React shows the dialog over the values the operator just typed, which is why the
 * console's gate has excluded that id since INC-21 and why nothing reachable has
 * ever called it. One check lived only on that step and therefore never ran for
 * any surface that shipped: the DA-3c bound of `qty` against the on-hand just
 * re-read. An over-removal is refused by the DOMAIN's guarded decrement instead,
 * which is asserted below. See ADR-0015, and `products-actions.ts`'s header.
 *
 * THE DEGRADED-OPERAND CASES ARE GONE WITH THE WIRE THAT COULD PRODUCE THEM. The
 * retired suite pinned five sentences composed from a rename refusal whose
 * operands the SERVICE had failed to send (`SKU_HELD_STOCK` with no `sku`, with a
 * non-numeric `liveHolds`, `SKU_STOCK_CONFLICT` with no `toSku`, …), each reached
 * by stubbing a malformed 409 body. In-process there is no body: the operands come
 * off typed domain errors — `SkuStockConflictError` carries both skus by
 * construction, `SkuHeldStockError` a positive integer count — and
 * `InProcessAdminProductsClient` normalises that count before this module sees it.
 * The fallback branches remain in `products-actions.ts` as defence, deliberately;
 * a test that hand-built the refusal to reach them would be asserting its own
 * fixture rather than this tier. The two REACHABLE rename refusals are pinned
 * whole, below.
 *
 * A green happy path is not evidence for any of this, so every refusal test also
 * reads the product back and asserts NOTHING was written.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
	type ProductCommerce,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	BACKORDERS_CONTEXT,
	LOW_STOCK_FILTER_DESCRIPTION,
	PRODUCTS_LIST_INTRO,
	REMOVE_STOCK_BANNER,
	REMOVE_STOCK_CONTEXT,
	STOCK_ON_HAND_CONTEXT,
	removeStockConfirm,
} from "@otta-sh/admin-presentation";
import { PRODUCTS_ACTION_IDS } from "../src/admin/products-actions.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const ACT = "otta_console_act";

/** A namespace no other suite writes under. The document store is process-scoped
 *  and reused across boots, so every id and every SKU this file mints carries the
 *  prefix and a counter — cases must not collide, least of all on `sku`, which is
 *  the natural key the rename rules are built around. */
const NS = "pa";

interface Notice {
	variant: string;
	title: string;
	description: string;
}
interface ActOutcome {
	ok?: boolean;
	title?: string;
	description?: string;
	notice?: Notice | null;
	/** Present only on an outcome about ONE input — see the rename refusals. */
	field?: string;
}

let sandbox: SandboxHandle;
let storage: StorageAccess;
let products: EmdashProductCommerceStore;
let inventory: EmdashInventoryStore;
let seq = 0;

beforeAll(async () => {
	({ storage } = await storageBridge());
	products = new EmdashProductCommerceStore({ storage, clock: systemClock });
	inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	// `allowedHosts: []` is the whole point of the increment: this screen's writes
	// make no egress at all now, so the isolate is granted none.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox?.close();
});

interface Seeded {
	readonly productId: string;
	readonly sku: string;
	/** The row's `updatedAt` at seed time — the optimistic-concurrency watermark
	 *  every save carries back. */
	readonly updatedAt: string;
}

/**
 * One live product row, and optionally its inventory document.
 *
 * `onHand: null` seeds NO inventory document, which is a different fact from `0`
 * and is what the two "no inventory record" cases below are about. The row goes in
 * through the store's own upsert rather than being hand-built, so the sku claim the
 * rename rules read is created the way a real write creates it.
 */
async function seedProduct(options: { onHand?: number | null } = {}): Promise<Seeded> {
	const n = ++seq;
	const productId = `${NS}-prod-${n}`;
	const sku = `${NS}-SKU-${n}`;
	const product = await products.upsert(
		{
			productId: toProductId(productId),
			sku: toSku(sku),
			title: "Blue Widget",
			price: money(cents(1999), toCurrency("USD")),
			taxClass: "standard",
			weightGrams: 300,
			lengthMm: 10,
			widthMm: 20,
			heightMm: 30,
			productKind: "physical",
		},
		idempotencyKey(`${NS}-seed-${String(n)}`),
	);
	const onHand = options.onHand === undefined ? 42 : options.onHand;
	if (onHand !== null) await inventory.seedOnHand(sku, onHand);
	return { productId, sku, updatedAt: product.updatedAt.toISOString() };
}

/** The persisted row, read back through the same adapter the write went through —
 *  the only evidence this suite accepts that anything happened. */
async function readProduct(productId: string): Promise<ProductCommerce> {
	const row = await products.getByProductId(toProductId(productId));
	if (row === null) throw new Error(`no product row for ${productId}`);
	return row;
}

/** One console write, exactly as `performAction` sends it: a flat payload, no
 *  carrier. */
async function act(actionId: string, value: Record<string, string>): Promise<ActOutcome> {
	const outcome = await sandbox.invokeRoute("admin", { type: ACT, action_id: actionId, value });
	expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
	return (outcome as { result: ActOutcome }).result;
}

/** The whole carrier the console sends with any of the three saves. */
const carrierFor = (seeded: Seeded): Record<string, string> => ({
	productId: seeded.productId,
	expectedUpdatedAt: seeded.updatedAt,
});

describe("the Pricing & inventory write path (workerd sandbox)", () => {
	// -- the dispatch gate ------------------------------------------------------

	test("an UNKNOWN action id is a refusal with copy, never a quiet success", async () => {
		// Reachable from a stale tab after a deploy that renamed an action, and from
		// a console bug — never from a control this release rendered. Reporting it as
		// an outcome would render a stock movement that never happened as done.
		const seeded = await seedProduct();
		const result = await act("products:no-such-action", { productId: seeded.productId });
		expect(result.ok).toBe(false);
		expect(result.title).toBe("Nothing was changed");
		expect(String(result.description)).toContain("Nothing was applied");
		expect((await readProduct(seeded.productId)).updatedAt.toISOString()).toBe(seeded.updatedAt);
	});

	test("EVERY id in PRODUCTS_ACTION_IDS dispatches, and the retired `-review` step is not among them", async () => {
		// The set is read straight off the dispatch table, so the gate and the table
		// cannot disagree about what exists — the combination that used to blank a
		// console. FIVE writes: three split saves, a restock and a removal.
		expect([...PRODUCTS_ACTION_IDS].toSorted()).toEqual([
			"products:remove-stock",
			"products:restock",
			"products:save-identity",
			"products:save-price",
			"products:save-shipping",
		]);
		// An id nothing reachable can send is dead surface, and an unreachable
		// safety check is not a safety check (ADR-0015's amendment). The React
		// screen composes its own confirm; there has never been a staged step for it
		// to render into.
		expect(PRODUCTS_ACTION_IDS.has("products:remove-stock-review")).toBe(false);
		for (const actionId of PRODUCTS_ACTION_IDS) {
			const result = await act(actionId, {});
			// No product id, so each one refuses as unreadable — but it REFUSES,
			// which only a registered id can do. An unregistered one answers
			// `ok: false`.
			expect(result.ok, actionId).toBe(true);
			expect(result.notice?.variant, actionId).toBe("error");
		}
	});

	// -- the three split saves --------------------------------------------------

	test("saving Identity writes ONLY the sku — every other stored field is PRESERVED, never cleared", async () => {
		// The verified sparse edit is what makes the three-way split legal on this
		// screen and nowhere else: a field absent from the payload is absent from the
		// update input, and the store's rule is that `undefined` PRESERVES — so
		// saving one group cannot silently clear another's values.
		const seeded = await seedProduct();
		const renamed = `${seeded.sku}-RENAMED`;
		const result = await act("products:save-identity", { ...carrierFor(seeded), sku: renamed });
		expect(result.notice?.title).toBe("Saved");

		const row = await readProduct(seeded.productId);
		expect(row.sku).toBe(renamed);
		expect(row.price).toEqual({ amount: 1999, currency: "USD" });
		expect(row.taxClass).toBe("standard");
		expect(row.weightGrams).toBe(300);
		expect(row.heightMm).toBe(30);
		expect(row.title).toBe("Blue Widget");
		expect(row.updatedAt.toISOString()).not.toBe(seeded.updatedAt);
		// THE RENAME CARRIED THE STOCK, which is the half of this write that is not
		// a string swap: `inventory` is keyed by the sku, so the units follow it or
		// the edit is refused.
		expect(await inventory.findOnHand(renamed)).toBe(42);
	});

	test("saving Price stores INTEGER MINOR UNITS, clears a blank compare-at to null, and touches nothing else", async () => {
		// M-3/B-2: money crosses this boundary as an exact integer minor-unit
		// amount, never a float — `parseFloat("24.50") * 100` is 2450.0000000000005
		// and this parser must yield exactly 2450.
		const seeded = await seedProduct();
		// A compare-at has to EXIST before "blank clears it" is a claim about
		// anything, so the first save sets one and the second clears it.
		const first = await act("products:save-price", {
			...carrierFor(seeded),
			price: "19.99",
			currency: "USD",
			compareAt: "30.00",
			unitCost: "8.50",
		});
		expect(first.notice?.title).toBe("Saved");
		const staged = await readProduct(seeded.productId);
		expect(staged.compareAtPrice).toEqual({ amount: 3000, currency: "USD" });

		await act("products:save-price", {
			productId: seeded.productId,
			expectedUpdatedAt: staged.updatedAt.toISOString(),
			price: "24.50",
			currency: "USD",
			compareAt: "",
			unitCost: "9.00",
		});
		const row = await readProduct(seeded.productId);
		expect(row.price).toEqual({ amount: 2450, currency: "USD" });
		expect(row.unitCost).toEqual({ amount: 900, currency: "USD" });
		// ABSENT IS NOT ZERO, and here the distinction is a merchant-visible fact: a
		// blank compare-at CLEARS the field, and `{amount: 0}` would be a compare-at
		// price of nothing at all.
		expect(row.compareAtPrice).toBeNull();
		// The other two forms' fields are untouched by a price save.
		expect(row.sku).toBe(seeded.sku);
		expect(row.taxClass).toBe("standard");
		expect(row.weightGrams).toBe(300);
	});

	test("a BLANK price leaves the stored price alone rather than zeroing it — the domain's price > 0 rule, upstream of the domain", async () => {
		// A free product is "unpriced", not priced at 0. A blank field means
		// "leave it alone", and turning that into an amount would be the same
		// absent-rendered-as-zero mistake in the write direction.
		const seeded = await seedProduct();
		await act("products:save-price", {
			...carrierFor(seeded),
			price: "",
			currency: "USD",
			compareAt: "12.00",
			unitCost: "",
		});
		const row = await readProduct(seeded.productId);
		expect(row.price).toEqual({ amount: 1999, currency: "USD" });
		expect(row.compareAtPrice).toEqual({ amount: 1200, currency: "USD" });
		expect(row.unitCost).toBeNull();
	});

	test("a malformed price is refused AT THE PLUGIN BOUNDARY — nothing is written", async () => {
		const seeded = await seedProduct();
		for (const price of ["19.999", "-5.00", "0", "1,999", "abc", "1.", ".5"]) {
			const result = await act("products:save-price", {
				...carrierFor(seeded),
				price,
				currency: "USD",
				compareAt: "",
				unitCost: "",
			});
			expect(result.notice?.variant, price).toBe("error");
			expect(result.notice?.title, price).toBe("Check the highlighted value");
			// The watermark is still the seed's, so nothing reached the store — a
			// refusal that had written would have moved it.
			const row = await readProduct(seeded.productId);
			expect(row.updatedAt.toISOString(), price).toBe(seeded.updatedAt);
			expect(row.price, price).toEqual({ amount: 1999, currency: "USD" });
		}
	});

	test("a price with no valid currency is refused — a money amount never travels without one", async () => {
		const seeded = await seedProduct();
		const result = await act("products:save-price", {
			...carrierFor(seeded),
			price: "24.50",
			currency: "US",
			compareAt: "",
			unitCost: "",
		});
		expect(String(result.notice?.description)).toContain("3-letter ISO-4217");
		expect((await readProduct(seeded.productId)).updatedAt.toISOString()).toBe(seeded.updatedAt);
	});

	test("saving Shipping writes kind/taxClass/dimensions; the `none` sentinel CLEARS the tax class to null", async () => {
		const seeded = await seedProduct();
		await act("products:save-shipping", {
			...carrierFor(seeded),
			productKind: "physical",
			taxClass: "none",
			weightGrams: "400",
			lengthMm: "11",
			widthMm: "21",
			heightMm: "31",
		});
		const row = await readProduct(seeded.productId);
		expect(row.taxClass).toBeNull();
		expect(row.productKind).toBe("physical");
		expect(row.weightGrams).toBe(400);
		expect(row.heightMm).toBe(31);
		expect(row.sku).toBe(seeded.sku);
		expect(row.price).toEqual({ amount: 1999, currency: "USD" });
	});

	test("a non-integer measurement is refused at the boundary — nothing is written", async () => {
		const seeded = await seedProduct();
		const result = await act("products:save-shipping", {
			...carrierFor(seeded),
			productKind: "physical",
			weightGrams: "1.5",
		});
		expect(String(result.notice?.description)).toContain("weightGrams");
		const row = await readProduct(seeded.productId);
		expect(row.updatedAt.toISOString()).toBe(seeded.updatedAt);
		expect(row.weightGrams).toBe(300);
	});

	test("G2 / ADR-0013: `title` and `active` can NEVER be written, however hostile the payload", async () => {
		// Both fields are CMS-owned — the title is a single-writer cache the sync
		// upserts on every publish, `active` is the CMS's publish gate — and neither
		// `ProductEditWire` nor `UpdateProductCommerceFieldsInput` has a member for
		// either, so nothing the console sends can reach the column. The Block Kit
		// screen enforced this by not rendering a field; a flat JSON payload has no
		// such protection, which is why it is asserted rather than assumed — and
		// asserted on the ROW now rather than on a request body, because the row is
		// where an operator would find the damage.
		const seeded = await seedProduct();
		// The publish gate as the row actually stands — a seeded row has never been
		// published, so it is `false`, and the claim is that this save cannot MOVE
		// it in either direction rather than that it happens to be true.
		const before = await readProduct(seeded.productId);
		const result = await act("products:save-identity", {
			...carrierFor(seeded),
			sku: `${seeded.sku}-OK`,
			title: "Renamed by the admin",
			active: "true",
		});
		// The hostile keys are DROPPED at the wire builder, not refused: the save
		// itself is a legitimate one.
		expect(result.notice?.title).toBe("Saved");
		const row = await readProduct(seeded.productId);
		expect(row.title).toBe("Blue Widget");
		expect(row.active).toBe(before.active);
	});

	test("a save with NO `expectedUpdatedAt` refuses rather than writing unchecked", async () => {
		// The watermark is what the store's optimistic concurrency compares. A save
		// that omits it is a clobber of whatever landed since the form was drawn, so
		// its absence is an unreadable payload — not permission.
		const seeded = await seedProduct();
		const payloads: Array<Record<string, string>> = [
			{ productId: seeded.productId, sku: `${seeded.sku}-X` },
			{ expectedUpdatedAt: seeded.updatedAt, sku: `${seeded.sku}-X` },
		];
		for (const payload of payloads) {
			const result = await act("products:save-identity", payload);
			expect(result.notice?.title, JSON.stringify(payload)).toBe("Not changed");
			const row = await readProduct(seeded.productId);
			expect(row.sku, JSON.stringify(payload)).toBe(seeded.sku);
			expect(row.updatedAt.toISOString(), JSON.stringify(payload)).toBe(seeded.updatedAt);
		}
	});

	test("a BLANK `expectedUpdatedAt` refuses HERE, on the same terms a blank on-hand does", async () => {
		// THE TWO WATERMARKS ARE GUARDED SYMMETRICALLY (INC-R3 review). A blank
		// stock watermark has always been refused at this boundary, because
		// `parseOnHandWatermark` rejects `""`. The edit watermark used to be
		// forwarded instead and refused a tier down, where `""` matched no
		// `updatedAt` and came back stale — fail-closed, but by a different route.
		// Two watermarks on one screen guarded on two different tiers is a trap for
		// whoever changes either tier next, so an empty or whitespace-only watermark
		// is an unreadable payload here, exactly like an absent one, and NOTHING is
		// written. (`requireWatermark` in `commerce-input.ts` refuses a blank one on
		// the client side too, so the two tiers agree rather than overlap by luck.)
		const seeded = await seedProduct();
		for (const blank of ["", "   "]) {
			const result = await act("products:save-identity", {
				...carrierFor(seeded),
				expectedUpdatedAt: blank,
				sku: `${seeded.sku}-X`,
			});
			expect(result.notice?.title, JSON.stringify(blank)).toBe("Not changed");
			expect((await readProduct(seeded.productId)).sku, JSON.stringify(blank)).toBe(seeded.sku);
		}
		// The stock watermark's half of the symmetry is asserted by "DA-3a is not
		// opt-out" below, which runs the same two blanks through a removal.
	});

	test("THE REPLAY CASE: one rendered form submitted twice applies ONCE and still reads Saved", async () => {
		// F-2a: the key is a content hash of the submitted wire plus
		// `expectedUpdatedAt`. Not a nonce — a render-time nonce would make a
		// double-submit two distinct saves.
		//
		// THE KEY IS NOT OBSERVABLE ANY MORE. It used to be read off an
		// `Idempotency-Key` header; in-process it is an argument to
		// `updateProductCommerceFields`. So it is proven by what it buys: the store
		// gives replay precedence over its own compare-and-set, so a resubmission
		// under the SAME key answers `ok` with the row the first one wrote — whereas
		// a second, DIFFERENT edit carrying that same now-stale watermark is refused
		// as stale, which is the third act below and is what makes this a test of
		// the key rather than of the watermark.
		const seeded = await seedProduct();
		const renamed = `${seeded.sku}-A`;
		await act("products:save-identity", { ...carrierFor(seeded), sku: renamed });
		const afterFirst = await readProduct(seeded.productId);
		expect(afterFirst.sku).toBe(renamed);

		const replay = await act("products:save-identity", { ...carrierFor(seeded), sku: renamed });
		expect(replay.notice?.title).toBe("Saved");
		const afterReplay = await readProduct(seeded.productId);
		// ONE write, not two: the replay did not re-stamp `updatedAt`.
		expect(afterReplay.updatedAt.toISOString()).toBe(afterFirst.updatedAt.toISOString());

		const other = await act("products:save-identity", {
			...carrierFor(seeded),
			sku: `${seeded.sku}-B`,
		});
		expect(other.notice?.title).toBe("This product changed since you opened it");
		expect((await readProduct(seeded.productId)).sku).toBe(renamed);
	});

	test("a concurrent-edit conflict reports a re-apply warning, never a clobber", async () => {
		// A REAL stale watermark now: the row moved after the form was drawn, and
		// the store's compare-and-set is what notices. The retired version of this
		// test injected a `409 STALE_EDIT` body, which could only ever prove the
		// plugin re-worded a status code.
		const seeded = await seedProduct();
		await act("products:save-price", {
			...carrierFor(seeded),
			price: "21.00",
			currency: "USD",
			compareAt: "",
			unitCost: "",
		});
		const result = await act("products:save-price", {
			...carrierFor(seeded),
			price: "24.99",
			currency: "USD",
			compareAt: "",
			unitCost: "",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("This product changed since you opened it");
		expect(String(result.notice?.description)).toContain("NOT applied");
		// The first save stands; the second was NOT applied over it.
		expect((await readProduct(seeded.productId)).price).toEqual({ amount: 2100, currency: "USD" });
	});

	test("the other refusals each get their own words, not one opaque failure", async () => {
		// Each is provoked with real state rather than an injected status code,
		// which is the only way left to reach them: the service that used to answer
		// 409/400/404 is gone, and every one of these is now a typed result or a
		// typed error out of the domain.
		const seeded = await seedProduct();

		// SKU already in use — another LIVE product holds the claim on that sku.
		const occupied = await seedProduct();
		const taken = await act("products:save-identity", {
			...carrierFor(seeded),
			sku: occupied.sku,
		});
		expect(taken.notice?.variant).toBe("error");
		expect(taken.notice?.title).toBe("SKU already in use");
		expect(String(taken.notice?.description)).toContain(occupied.sku);

		// Currency cannot be changed here — the row is priced in USD.
		const currencyMismatch = await act("products:save-price", {
			...carrierFor(seeded),
			price: "24.50",
			currency: "EUR",
			compareAt: "",
			unitCost: "",
		});
		expect(currencyMismatch.notice?.title).toBe("Currency cannot be changed here");

		// Invalid value — the input boundary refusing a product id that is not an id
		// token (it carries whitespace), which is the case the wire's schema 400
		// used to cover.
		const invalid = await act("products:save-identity", {
			productId: "bad id",
			expectedUpdatedAt: seeded.updatedAt,
			sku: `${NS}-SKU-nowhere`,
		});
		expect(invalid.notice?.title).toBe("Invalid value");

		// Product not found — an id no row carries.
		const missing = await act("products:save-identity", {
			productId: `${NS}-prod-nowhere`,
			expectedUpdatedAt: seeded.updatedAt,
			sku: `${NS}-SKU-nowhere`,
		});
		expect(missing.notice?.title).toBe("Product not found");

		// None of the four wrote anything.
		const row = await readProduct(seeded.productId);
		expect(row.sku).toBe(seeded.sku);
		expect(row.updatedAt.toISOString()).toBe(seeded.updatedAt);
	});

	// -- the two RENAME refusals, and where they belong -------------------------
	// The domain raises a typed error carrying operands; the sentence an operator
	// reads is composed HERE and nowhere else, so these assertions are on the copy
	// itself rather than on a code the console would have to re-word. Each names
	// what the operator has to know to act — which skus, or how many holds — and
	// each carries `field: "sku"`, which is what puts it beside the input that
	// caused it instead of at the top of the screen.

	test("a rename onto an occupied sku names BOTH skus, says nothing moved, and belongs to the SKU field", async () => {
		// The target sku has an inventory document and no live owner — units that
		// belong to nobody living, which is exactly the case "occupied is occupied"
		// refuses rather than merging.
		const seeded = await seedProduct();
		const retired = `${NS}-SKU-retired-${String(seq)}`;
		await inventory.seedOnHand(retired, 7);

		const result = await act("products:save-identity", { ...carrierFor(seeded), sku: retired });

		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("That SKU already has stock of its own");
		const sentence = String(result.notice?.description);
		// THE WHOLE SENTENCE, not fragments of it. A fragment pin passes over a
		// clause that reads as broken English around the value it interpolates,
		// which is exactly the defect this file exists to catch.
		expect(sentence).toBe(
			`Nothing was changed. Stock is never merged between SKUs, and "${retired}" already has ` +
				`its own inventory record — so "${seeded.sku}" was not renamed onto it. Rename to a SKU ` +
				`that has never held stock, or move the units under "${retired}" elsewhere first.`,
		);
		expect(result.field).toBe("sku");
		// Nothing moved: the row keeps its sku and the target keeps its units.
		expect((await readProduct(seeded.productId)).sku).toBe(seeded.sku);
		expect(await inventory.findOnHand(retired)).toBe(7);
	});

	test("a rename blocked by live holds names the sku AND the count, and the whole sentence agrees with it", async () => {
		// THE SINGULAR IS THE COMMON CASE, and a pluralised noun gets it wrong twice
		// over — at the verb ("1 live reservation still hold units") and again at the
		// pronoun the advice refers back with ("once those have been paid", of one
		// reservation). Both forms are pinned WHOLE, end to end, for that reason.
		//
		// The holds are REAL reservations against the source sku, taken through the
		// inventory adapter: the state `SkuStockTransfer` refuses on, rather than a
		// count an HTTP fixture asserted.
		for (const [liveHolds, settled] of [
			[3, "those have"],
			[1, "it has"],
		] as const) {
			const seeded = await seedProduct();
			for (let i = 0; i < liveHolds; i++) {
				const held = await inventory.reserve(
					seeded.sku,
					1,
					idempotencyKey(`${NS}-hold-${String(seq)}-${String(i)}`),
				);
				expect(held.ok, `reservation ${String(i)} of ${String(liveHolds)}`).toBe(true);
			}
			const clause =
				liveHolds === 1
					? `1 live reservation still holds units of "${seeded.sku}"`
					: `${String(liveHolds)} live reservations still hold units of "${seeded.sku}"`;

			const result = await act("products:save-identity", {
				...carrierFor(seeded),
				sku: `${seeded.sku}-MOVED`,
			});

			expect(result.notice?.variant, clause).toBe("error");
			expect(result.notice?.title, clause).toBe("This SKU has reservations in flight");
			expect(String(result.notice?.description), clause).toBe(
				`Nothing was changed: ${clause}, and a reservation cannot follow a rename — its units ` +
					"would return to the old SKU when the cart or order finishes. Try the rename again once " +
					`${settled} been paid, cancelled or expired, usually a few minutes.`,
			);
			expect(result.field, clause).toBe("sku");
			expect((await readProduct(seeded.productId)).sku, clause).toBe(seeded.sku);
		}
	});

	test("every OTHER outcome names no field at all — the top of the screen is still the default", async () => {
		// The plain edit path is untouched by the two refusals above: a save, a
		// stale watermark, the live-sku collision and an unknown product all still
		// report where they always did, and a screen reading `field` gets nothing to
		// route on.
		const seeded = await seedProduct();
		const occupied = await seedProduct();

		const saved = await act("products:save-identity", {
			...carrierFor(seeded),
			sku: `${seeded.sku}-OK`,
		});
		expect(saved.notice?.title).toBe("Saved");
		expect(saved.field).toBeUndefined();

		// The same watermark again — now stale, because the save above moved it.
		const stale = await act("products:save-identity", {
			...carrierFor(seeded),
			sku: `${seeded.sku}-AGAIN`,
		});
		expect(stale.notice?.title).toBe("This product changed since you opened it");
		expect(stale.field).toBeUndefined();

		const fresh = (await readProduct(seeded.productId)).updatedAt.toISOString();
		const collision = await act("products:save-identity", {
			productId: seeded.productId,
			expectedUpdatedAt: fresh,
			sku: occupied.sku,
		});
		expect(collision.notice?.title).toBe("SKU already in use");
		expect(collision.field).toBeUndefined();

		const missing = await act("products:save-identity", {
			productId: `${NS}-prod-nowhere-2`,
			expectedUpdatedAt: fresh,
			sku: `${NS}-SKU-nowhere-2`,
		});
		expect(missing.notice?.title).toBe("Product not found");
		expect(missing.field).toBeUndefined();
	});

	// -- restock (DA-4: one-shot, no staging) -----------------------------------

	test("a restock ADDS the units to the real count and says what the count is now", async () => {
		const seeded = await seedProduct({ onHand: 42 });
		const result = await act("products:restock", {
			productId: seeded.productId,
			onHand: "42",
			qty: "8",
		});
		expect(result.notice?.variant).toBe("default");
		expect(result.notice?.title).toBe("Stock added");
		expect(String(result.notice?.description)).toContain("Added 8 units");
		expect(await inventory.findOnHand(seeded.sku)).toBe(50);
	});

	test("a restock does NOT re-read stock first — it is additive, and the watermark is only a key component", async () => {
		// The asymmetry with a removal is the point (DA-4 versus DA-3/DA-5): adding
		// stock cannot oversell anything, so it is one-shot. Its watermark buys
		// idempotency, not a staleness check, and pretending otherwise would put a
		// round trip on the cheap path.
		//
		// The retired suite proved this by counting GETs to the stub. There is no
		// request to count now, so it is proven by the BEHAVIOUR the absent re-read
		// produces: the payload's watermark disagrees with live stock, and the
		// restock applies anyway — which a DA-3a re-read would have refused.
		const seeded = await seedProduct({ onHand: 30 });
		const result = await act("products:restock", {
			productId: seeded.productId,
			onHand: "42", // a stale count; a removal refuses on exactly this
			qty: "8",
		});
		expect(result.notice?.title).toBe("Stock added");
		expect(await inventory.findOnHand(seeded.sku)).toBe(38);
	});

	test("a non-positive or non-integer restock quantity is refused at the boundary — nothing is added", async () => {
		const seeded = await seedProduct({ onHand: 42 });
		for (const qty of ["-4", "0", "1.5", "abc", ""]) {
			const result = await act("products:restock", {
				productId: seeded.productId,
				onHand: "42",
				qty,
			});
			expect(result.notice?.variant, qty).toBe("error");
			expect(await inventory.findOnHand(seeded.sku), qty).toBe(42);
		}
	});

	test("THE REPLAY CASE, on stock: one rendered form submitted twice moves ONCE; a fresh watermark moves again", async () => {
		// The whole reason the key is content-derived rather than a nonce. A
		// double-click of the same control must dedupe, and two DELIBERATE restocks
		// of the same size must both apply — which they do because the second is
		// taken against the on-hand the first produced.
		const seeded = await seedProduct({ onHand: 42 });
		const payload = { productId: seeded.productId, onHand: "42", qty: "8" };

		await act("products:restock", payload);
		const replay = await act("products:restock", payload);
		// TWO submissions, ONE movement: 42 + 8, and the replay is answered with the
		// same figure rather than 58.
		expect(await inventory.findOnHand(seeded.sku)).toBe(50);
		expect(String(replay.notice?.description)).toContain("50");

		// A re-render reads the NEW on-hand, so the next submission carries a
		// different watermark ⇒ a different key ⇒ a second, deliberate restock.
		await act("products:restock", { productId: seeded.productId, onHand: "50", qty: "8" });
		expect(await inventory.findOnHand(seeded.sku)).toBe(58);
	});

	// -- remove stock (the screen's ONE destructive act) ------------------------

	test("a removal re-reads live stock, then removes exactly the units asked for", async () => {
		const seeded = await seedProduct({ onHand: 42 });
		const result = await act("products:remove-stock", {
			productId: seeded.productId,
			qty: "5",
			onHand: "42",
		});
		expect(result.notice?.variant).toBe("default");
		expect(result.notice?.title).toBe("Stock removed");
		expect(await inventory.findOnHand(seeded.sku)).toBe(37);
	});

	test("DA-3a: stock that moved since the operator saw it refuses the removal, names the new figure, and removes NOTHING", async () => {
		// THE GATE. The operator opened a confirm against 42; someone else removed
		// 12 in the meantime, so the dialog they read is already false. Nothing may
		// move, and the refusal has to say what the count is NOW — an operator who
		// is not told the new figure retries the same wrong amount.
		const seeded = await seedProduct({ onHand: 30 });
		const result = await act("products:remove-stock", {
			productId: seeded.productId,
			qty: "10", // valid against the stale 42 AND against the live 30
			onHand: "42",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Stock changed — nothing was removed");
		expect(String(result.notice?.description)).toContain("30 units are on hand now");
		expect(await inventory.findOnHand(seeded.sku)).toBe(30);
	});

	test("DA-3a: a re-read carrying NO inventory record gets its own sentence, never a count of zero", async () => {
		// `null` is "this sku has no inventory record", which is not "0 units". A
		// refusal reading "0 units are on hand now" would state a count nobody took.
		const seeded = await seedProduct({ onHand: null });
		expect(await inventory.findOnHand(seeded.sku)).toBeNull();
		const result = await act("products:remove-stock", {
			productId: seeded.productId,
			qty: "5",
			onHand: "42",
		});
		expect(result.notice?.title).toBe("Stock changed — nothing was removed");
		expect(String(result.notice?.description)).toContain("no longer has an inventory record");
		expect(String(result.notice?.description)).not.toContain("0 units");
		expect(await inventory.findOnHand(seeded.sku)).toBeNull();
	});

	test("DA-3a is not opt-out: a removal payload with the watermark STRIPPED refuses, and removes nothing", async () => {
		// An absent watermark has exactly two sources — a payload edited in
		// devtools, or a tab rendered before the watermark existed, which is
		// precisely the stale view DA-3a is for — and refusing is right for both.
		// The refusal happens BEFORE the re-read, because no re-read can supply a
		// watermark the operator never sent; tolerating it would remove the
		// staleness check entirely while looking like caution.
		const seeded = await seedProduct({ onHand: 42 });
		for (const onHand of [undefined, "", "  ", "-1", "4.5", "abc"]) {
			const result = await act("products:remove-stock", {
				productId: seeded.productId,
				qty: "5",
				...(onHand === undefined ? {} : { onHand }),
			});
			expect(result.notice?.title, JSON.stringify(onHand)).toBe("Not changed");
			expect(await inventory.findOnHand(seeded.sku), JSON.stringify(onHand)).toBe(42);
		}
	});

	test("a removal whose product could not be re-read applies NOTHING and says so", async () => {
		const result = await act("products:remove-stock", {
			productId: `${NS}-prod-nowhere-3`,
			qty: "5",
			onHand: "42",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Nothing was removed");
	});

	test("the DOMAIN's guarded decrement still surfaces a clean refusal — never a negative", async () => {
		// The bound the re-read cannot enforce: the operator's observed count is
		// CURRENT (so DA-3a passes) and the quantity is simply larger than it. The
		// domain applies a guarded decrement and refuses with the live count, and
		// this is now the ONLY bound check on the path — the client-side one lived
		// on the unreached `-review` step (ADR-0015).
		const seeded = await seedProduct({ onHand: 42 });
		const result = await act("products:remove-stock", {
			productId: seeded.productId,
			qty: "50",
			onHand: "42",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Not enough stock to remove");
		expect(String(result.notice?.description)).toContain("Only 42 units on hand");
		expect(String(result.notice?.description)).toContain("you cannot remove 50");
		// Never a negative, and never a partial removal.
		expect(await inventory.findOnHand(seeded.sku)).toBe(42);
	});

	test("a movement against a sku with no stock record names the state and the way out", async () => {
		const seeded = await seedProduct({ onHand: null });
		const result = await act("products:restock", {
			productId: seeded.productId,
			onHand: "42",
			qty: "1",
		});
		expect(result.notice?.title).toBe("No stock record yet");
		expect(String(result.notice?.description)).toContain("Re-save the SKU");
		expect(await inventory.findOnHand(seeded.sku)).toBeNull();
	});

	// -- copy ------------------------------------------------------------------

	test("X-20: no operator-facing string on this screen says `oversell`", async () => {
		// The retired suite asserted this over a RENDERED detail response, via the
		// block contract's banned-slogan check. The screen is gone and its copy now
		// lives in `@otta-sh/admin-presentation`, shared with the React tier — so
		// the same claim is made about the strings themselves, plus every notice a
		// write can produce. Out-of-stock policy is deny-only and the copy states
		// the MECHANISM rather than sloganeering about it.
		const banned = /oversell|oversold|overselling/i;
		const copy = [
			BACKORDERS_CONTEXT,
			LOW_STOCK_FILTER_DESCRIPTION,
			PRODUCTS_LIST_INTRO,
			REMOVE_STOCK_BANNER.title,
			REMOVE_STOCK_BANNER.description,
			REMOVE_STOCK_CONTEXT,
			STOCK_ON_HAND_CONTEXT,
			removeStockConfirm(3).text,
		];
		for (const text of copy) expect(text, text).not.toMatch(banned);

		const seeded = await seedProduct({ onHand: 30 });
		const refusal = await act("products:remove-stock", {
			productId: seeded.productId,
			qty: "5",
			onHand: "42",
		});
		const ok = await act("products:restock", {
			productId: seeded.productId,
			onHand: "30",
			qty: "1",
		});
		for (const outcome of [refusal, ok]) {
			expect(JSON.stringify(outcome)).not.toMatch(banned);
		}
	});
});
