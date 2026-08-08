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
 * THE FOUR INVARIANTS THIS SCREEN'S GATE IS MADE OF, each proven below:
 *
 *  1. **Money is integer minor units, and absent is not zero.** A price reaches
 *     the wire as `{amount, currency}` in minor units or not at all; a malformed
 *     one is refused BEFORE any request; a blank compare-at is an explicit `null`
 *     CLEAR and never a zero; a blank price is OMITTED and never a zero.
 *  2. **The stale-watermark refusal (DA-3a), carried verbatim.** A stock removal
 *     re-reads live stock and refuses on a mismatch with NOTHING posted — and an
 *     ABSENT watermark refuses fail-closed, with no re-read at all. A save carries
 *     `expectedUpdatedAt` and refuses without one rather than clobbering.
 *  3. **Idempotency without a nonce, and the replay case.** Every key is derived
 *     from content plus the watermark the operator saw, so a double-submit of one
 *     rendered form dedupes while two deliberate movements taken against two
 *     different observed counts both apply.
 *  4. **The verified sparse PATCH.** Each of the three split saves sends its own
 *     fields and nothing else, and `title`/`active` can never reach the wire at
 *     all (G2 / ADR-0013) however hostile the payload is.
 *
 * WHAT IS NOT TESTED HERE, AND WHY THAT IS NOT A SILENT GAP.
 * `products:remove-stock-review` — DA-3 state 1 → state 2 — is not ported. It
 * staged a quantity server-side so a SECOND RENDER could draw a confirm button;
 * React shows the dialog over the values the operator just typed, which is why the
 * console's gate has excluded that id since INC-21 and why nothing reachable has
 * ever called it. One check lived only on that step and therefore never ran for
 * any surface that shipped: the DA-3c bound of `qty` against the on-hand just
 * re-read. An over-removal is refused by the SERVICE's guarded decrement instead,
 * which is asserted below. See ADR-0015, and `products-actions.ts`'s header.
 *
 * A green happy path is not evidence for any of this, so every refusal test also
 * asserts that NOTHING was written.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";

const ACT = "otta_console_act";
const PRODUCT_ID = "prod-1";
const ADMIN_TOKEN = "admin-token-xyz";
const SERVICE_TOKEN = "svc-token-abc";
/** The product's `updatedAt` — the optimistic-concurrency watermark every save
 *  carries back. */
const UPDATED_AT = "2026-07-12T01:00:00.000Z";

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

/** Mutable read-time state the GET responder serves — lets a test move stock
 *  between the render and the write without hand-crafting anything. `null` is the
 *  service saying this sku has NO inventory record, which is a different fact
 *  from `0` and must never be folded into one. */
interface LiveState {
	onHand: number | null;
}

function detail(state: LiveState): Record<string, unknown> {
	return {
		productId: PRODUCT_ID,
		sku: "SKU-1",
		title: "Blue Widget",
		priceCents: 1999,
		currency: "USD",
		taxClass: "standard",
		compareAtCents: 3000,
		compareAtCurrency: "USD",
		unitCostCents: 850,
		unitCostCurrency: "USD",
		inventoryPolicy: "deny",
		weightGrams: 300,
		lengthMm: 10,
		widthMm: 20,
		heightMm: 30,
		productKind: "physical",
		active: true,
		deletedAt: null,
		onHand: state.onHand,
		createdAt: "2026-07-12T00:00:00.000Z",
		updatedAt: UPDATED_AT,
	};
}

/** One request header, case-insensitively. */
function header(request: RecordedRequest | undefined, name: string): string | undefined {
	const value = request?.headers[name.toLowerCase()];
	return typeof value === "string" ? value : undefined;
}

describe("the Pricing & inventory write path (workerd sandbox)", () => {
	let service: StubCommerceServer;
	let sandbox: SandboxHandle;
	let live: LiveState;

	beforeEach(async () => {
		live = { onHand: 42 };
		service = await startStubCommerceServer();
		// GET routing is a function of the path, so a surface a write is not
		// supposed to read 404s — which is itself part of every assertion.
		service.respondWith("GET", (request) => {
			const path = request.url.split("?")[0] ?? "";
			if (path === `/admin/products/${PRODUCT_ID}`) {
				return { status: 200, body: { ok: true, product: detail(live) } };
			}
			return { status: 404, body: { error: "no route" } };
		});
		service.respondWith("PATCH", () => ({
			status: 200,
			body: { ok: true, updatedAt: UPDATED_AT },
		}));
		service.respondWith("POST", (request) => {
			const qty = (request.body as { qty?: number } | undefined)?.qty ?? 0;
			if (request.url === `/admin/products/${PRODUCT_ID}/restock`) {
				return { status: 200, body: { ok: true, onHand: (live.onHand ?? 0) + qty } };
			}
			if (request.url === `/admin/products/${PRODUCT_ID}/remove-stock`) {
				// The service's OWN guarded decrement, on a magic quantity: the race
				// the plugin's re-read cannot always catch.
				if (qty === 777) {
					return { status: 409, body: { ok: false, reason: "INSUFFICIENT_STOCK", onHand: 42 } };
				}
				return { status: 200, body: { ok: true, onHand: (live.onHand ?? 0) - qty } };
			}
			return { status: 404, body: { error: "no route" } };
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [service.host],
			commerceServiceBaseUrl: service.baseUrl,
		});
		// BOTH tokens: the edit PATCH and the stock POSTs are non-GETs the write
		// gate blocks without the service token, and seeding them here is what lets
		// each test assert the headers rather than assume them.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: ADMIN_TOKEN },
		});
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-service-token",
			values: { serviceToken: SERVICE_TOKEN },
		});
		service.requests.length = 0;
	});

	afterEach(async () => {
		await sandbox.close();
		await service.close();
	});

	/** One console write, exactly as `performAction` sends it: a flat payload,
	 *  no carrier. */
	async function act(actionId: string, value: Record<string, string>): Promise<ActOutcome> {
		const outcome = await sandbox.invokeRoute("admin", { type: ACT, action_id: actionId, value });
		expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
		return (outcome as { result: ActOutcome }).result;
	}

	const writes = (): RecordedRequest[] =>
		service.requests.filter((r) => r.method === "PATCH" || r.method === "POST");
	const patch = (): RecordedRequest | undefined =>
		service.requests.find((r) => r.method === "PATCH");
	const patchBody = (): Record<string, unknown> => (patch()?.body ?? {}) as Record<string, unknown>;
	const postTo = (suffix: string): RecordedRequest | undefined =>
		service.requests.find(
			(r) => r.method === "POST" && r.url === `/admin/products/${PRODUCT_ID}${suffix}`,
		);

	/** The whole carrier the console sends with any of the three saves. */
	const carrier = { productId: PRODUCT_ID, expectedUpdatedAt: UPDATED_AT };

	// -- the dispatch gate ------------------------------------------------------

	test("an UNKNOWN action id is a refusal with copy, never a quiet success", async () => {
		// Reachable from a stale tab after a deploy that renamed an action, and from
		// a console bug — never from a control this release rendered. Reporting it as
		// an outcome would render a stock movement that never happened as done.
		const result = await act("products:no-such-action", { productId: PRODUCT_ID });
		expect(result.ok).toBe(false);
		expect(result.title).toBe("Nothing was changed");
		expect(String(result.description)).toContain("Nothing was applied");
		expect(writes()).toHaveLength(0);
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
		expect(writes()).toHaveLength(0);
	});

	// -- the three split saves --------------------------------------------------

	test("saving Identity PATCHes ONLY sku + expectedUpdatedAt — every other field is OMITTED, never nulled", async () => {
		// The verified sparse PATCH is what makes the three-way split legal on this
		// screen and nowhere else: a field absent from the payload is absent from the
		// wire, so saving one group cannot silently clear another's values.
		const result = await act("products:save-identity", { ...carrier, sku: "SKU-1-RENAMED" });
		expect(patch()).toBeDefined();
		expect(patch()?.url).toContain(`/admin/products/${PRODUCT_ID}`);
		expect(Object.keys(patchBody()).toSorted()).toEqual(["expectedUpdatedAt", "sku"]);
		expect(patchBody()["sku"]).toBe("SKU-1-RENAMED");
		expect(patchBody()["expectedUpdatedAt"]).toBe(UPDATED_AT);
		expect(header(patch(), "X-Internal-Token")).toBe(ADMIN_TOKEN);
		expect(header(patch(), "X-Service-Token")).toBe(SERVICE_TOKEN);
		expect(result.notice?.title).toBe("Saved");
	});

	test("saving Price sends INTEGER MINOR UNITS, clears a blank compare-at to null, and touches nothing else", async () => {
		// M-3/B-2: money crosses this boundary as an exact integer minor-unit
		// amount, never a float — `parseFloat("24.50") * 100` is 2450.0000000000005
		// and this parser must yield exactly 2450.
		await act("products:save-price", {
			...carrier,
			price: "24.50",
			currency: "USD",
			compareAt: "",
			unitCost: "9.00",
		});
		expect(patchBody()["price"]).toEqual({ amount: 2450, currency: "USD" });
		expect(patchBody()["unitCost"]).toEqual({ amount: 900, currency: "USD" });
		// ABSENT IS NOT ZERO, and here the distinction is a merchant-visible fact: a
		// blank compare-at CLEARS the field, and `{amount: 0}` would be a compare-at
		// price of nothing at all.
		expect(patchBody()["compareAtPrice"]).toBeNull();
		expect("sku" in patchBody()).toBe(false);
		expect("taxClass" in patchBody()).toBe(false);
		expect("weightGrams" in patchBody()).toBe(false);
	});

	test("a BLANK price is omitted rather than sent as zero — the domain's price > 0 rule, upstream of the domain", async () => {
		// A free product is "unpriced", not priced at 0. A blank field means
		// "leave it alone", and turning that into an amount would be the same
		// absent-rendered-as-zero mistake in the write direction.
		await act("products:save-price", {
			...carrier,
			price: "",
			currency: "USD",
			compareAt: "12.00",
			unitCost: "",
		});
		expect("price" in patchBody()).toBe(false);
		expect(patchBody()["compareAtPrice"]).toEqual({ amount: 1200, currency: "USD" });
		expect(patchBody()["unitCost"]).toBeNull();
	});

	test("a malformed price is refused AT THE PLUGIN BOUNDARY — nothing is sent", async () => {
		for (const price of ["19.999", "-5.00", "0", "1,999", "abc", "1.", ".5"]) {
			service.requests.length = 0;
			const result = await act("products:save-price", {
				...carrier,
				price,
				currency: "USD",
				compareAt: "",
				unitCost: "",
			});
			expect(writes(), price).toHaveLength(0);
			expect(result.notice?.variant, price).toBe("error");
			expect(result.notice?.title, price).toBe("Check the highlighted value");
		}
	});

	test("a price with no valid currency is refused — a money amount never travels without one", async () => {
		const result = await act("products:save-price", {
			...carrier,
			price: "24.50",
			currency: "US",
			compareAt: "",
			unitCost: "",
		});
		expect(writes()).toHaveLength(0);
		expect(String(result.notice?.description)).toContain("3-letter ISO-4217");
	});

	test("saving Shipping PATCHes kind/taxClass/dimensions; the `none` sentinel CLEARS the tax class to null", async () => {
		await act("products:save-shipping", {
			...carrier,
			productKind: "physical",
			taxClass: "none",
			weightGrams: "400",
			lengthMm: "11",
			widthMm: "21",
			heightMm: "31",
		});
		expect(patchBody()["taxClass"]).toBeNull();
		expect(patchBody()["productKind"]).toBe("physical");
		expect(patchBody()["weightGrams"]).toBe(400);
		expect(patchBody()["heightMm"]).toBe(31);
		expect("sku" in patchBody()).toBe(false);
		expect("price" in patchBody()).toBe(false);
	});

	test("a non-integer measurement is refused at the boundary — nothing is sent", async () => {
		const result = await act("products:save-shipping", {
			...carrier,
			productKind: "physical",
			weightGrams: "1.5",
		});
		expect(writes()).toHaveLength(0);
		expect(String(result.notice?.description)).toContain("weightGrams");
	});

	test("G2 / ADR-0013: `title` and `active` can NEVER reach the wire, however hostile the payload", async () => {
		// Both fields are CMS-owned — the title is a single-writer cache the sync
		// upserts on every publish, `active` is the CMS's publish gate — and
		// `ProductEditWire` has no member for either, so nothing the console sends
		// can put one on the wire. The Block Kit screen enforced this by not
		// rendering a field; a flat JSON payload has no such protection, which is
		// why it is asserted rather than assumed.
		await act("products:save-identity", {
			...carrier,
			sku: "S-1",
			title: "Renamed by the admin",
			active: "false",
		});
		expect(patchBody()).not.toHaveProperty("title");
		expect(patchBody()).not.toHaveProperty("active");
		expect(JSON.stringify(patchBody())).not.toContain("Renamed by the admin");
	});

	test("a save with NO `expectedUpdatedAt` refuses rather than PATCHing unchecked", async () => {
		// The watermark is what the service's optimistic concurrency compares. A
		// save that omits it is a clobber of whatever landed since the form was
		// drawn, so its absence is an unreadable payload — not permission.
		const payloads: Array<Record<string, string>> = [
			{ productId: PRODUCT_ID, sku: "S-1" },
			{ expectedUpdatedAt: UPDATED_AT, sku: "S-1" },
		];
		for (const payload of payloads) {
			service.requests.length = 0;
			const result = await act("products:save-identity", payload);
			expect(writes(), JSON.stringify(payload)).toHaveLength(0);
			expect(result.notice?.title, JSON.stringify(payload)).toBe("Not changed");
		}
	});

	test("a BLANK `expectedUpdatedAt` refuses HERE, on the same terms a blank on-hand does", async () => {
		// THE TWO WATERMARKS ARE GUARDED SYMMETRICALLY (INC-R3 review). A blank
		// stock watermark has always been refused at this boundary, because
		// `parseOnHandWatermark` rejects `""`. The edit watermark used to be
		// forwarded instead and refused downstream, where `""` matches no
		// `updatedAt` and comes back STALE_EDIT — fail-closed, but by a different
		// route. Two watermarks on one screen guarded on two different tiers is a
		// trap for whoever changes either tier next, so an empty or whitespace-only
		// watermark is now an unreadable payload, exactly like an absent one, and
		// NOTHING is sent.
		for (const blank of ["", "   "]) {
			service.requests.length = 0;
			const result = await act("products:save-identity", {
				...carrier,
				expectedUpdatedAt: blank,
				sku: "S-1",
			});
			expect(writes(), JSON.stringify(blank)).toHaveLength(0);
			expect(result.notice?.title, JSON.stringify(blank)).toBe("Not changed");
		}
		// The stock watermark's half of the symmetry is asserted by "DA-3a is not
		// opt-out" below, which runs the same two blanks through a removal.
	});

	test("a save carries a CONTENT-DERIVED Idempotency-Key, and the same submission replays to the same key", async () => {
		// F-2a: a content hash of the submitted wire plus `expectedUpdatedAt`. Not a
		// nonce — a render-time nonce would make a double-submit two distinct saves.
		await act("products:save-identity", { ...carrier, sku: "SKU-A" });
		const first = header(patch(), "Idempotency-Key");
		expect(first).toMatch(new RegExp(`^${PRODUCT_ID}:edit:`));

		service.requests.length = 0;
		await act("products:save-identity", { ...carrier, sku: "SKU-A" });
		expect(header(patch(), "Idempotency-Key")).toBe(first);

		// ...and a DIFFERENT edit is a different key, so it is not deduped away.
		service.requests.length = 0;
		await act("products:save-identity", { ...carrier, sku: "SKU-B" });
		expect(header(patch(), "Idempotency-Key")).not.toBe(first);
	});

	test("a concurrent-edit conflict (409 STALE_EDIT) reports a re-apply warning, never a clobber", async () => {
		service.respondWith("PATCH", () => ({
			status: 409,
			body: { reason: "STALE_EDIT", currentUpdatedAt: "2026-07-30T00:00:00.000Z" },
		}));
		const result = await act("products:save-price", {
			...carrier,
			price: "24.99",
			currency: "USD",
			compareAt: "",
			unitCost: "",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("This product changed since you opened it");
		expect(String(result.notice?.description)).toContain("NOT applied");
	});

	test("the service's other refusals each get their own words, not one opaque failure", async () => {
		const cases: Array<[Record<string, unknown>, number, string]> = [
			[{ reason: "SKU_TAKEN", sku: "SKU-DUP" }, 409, "SKU already in use"],
			[{ reason: "CURRENCY_MISMATCH", currency: "EUR" }, 409, "Currency cannot be changed here"],
			[{ field: "price" }, 400, "Invalid value"],
			[{}, 404, "Product not found"],
		];
		for (const [body, status, title] of cases) {
			service.respondWith("PATCH", () => ({ status, body }));
			const result = await act("products:save-identity", { ...carrier, sku: "S-1" });
			expect(result.notice?.variant, title).toBe("error");
			expect(result.notice?.title, title).toBe(title);
		}
	});

	// -- the two RENAME refusals, and where they belong -------------------------
	// The service answers a machine code plus operands; the sentence an operator
	// reads is composed HERE and nowhere else, so these assertions are on the copy
	// itself rather than on a code the console would have to re-word. Each names
	// what the operator has to know to act — which skus, or how many holds — and
	// each carries `field: "sku"`, which is what puts it beside the input that
	// caused it instead of at the top of the screen.

	test("a rename onto an occupied sku names BOTH skus, says nothing moved, and belongs to the SKU field", async () => {
		service.respondWith("PATCH", () => ({
			status: 409,
			body: { ok: false, reason: "SKU_STOCK_CONFLICT", fromSku: "SKU-1", toSku: "SKU-RETIRED" },
		}));
		const result = await act("products:save-identity", { ...carrier, sku: "SKU-RETIRED" });

		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("That SKU already has stock of its own");
		const sentence = String(result.notice?.description);
		// THE WHOLE SENTENCE, not fragments of it. A fragment pin passes over a
		// clause that reads as broken English around the value it interpolates,
		// which is exactly the defect this file exists to catch.
		expect(sentence).toBe(
			'Nothing was changed. Stock is never merged between SKUs, and "SKU-RETIRED" already has ' +
				'its own inventory record — so "SKU-1" was not renamed onto it. Rename to a SKU that has ' +
				'never held stock, or move the units under "SKU-RETIRED" elsewhere first.',
		);
		expect(result.field).toBe("sku");
	});

	test("a rename blocked by live holds names the sku AND the count, and the whole clause agrees with it", async () => {
		// THE SINGULAR IS THE COMMON CASE, and it is the one a pluralised noun with a
		// fixed verb gets wrong ("1 live reservation still hold units"). Both forms
		// are pinned as complete clauses for that reason.
		for (const [liveHolds, clause] of [
			[3, '3 live reservations still hold units of "SKU-1"'],
			[1, '1 live reservation still holds units of "SKU-1"'],
		] as const) {
			service.respondWith("PATCH", () => ({
				status: 409,
				body: { ok: false, reason: "SKU_HELD_STOCK", sku: "SKU-1", liveHolds },
			}));
			const result = await act("products:save-identity", { ...carrier, sku: "SKU-NEW" });

			expect(result.notice?.variant, clause).toBe("error");
			expect(result.notice?.title, clause).toBe("This SKU has reservations in flight");
			expect(String(result.notice?.description), clause).toBe(
				`Nothing was changed: ${clause}, and a reservation cannot follow a rename — its units ` +
					"would return to the old SKU when the cart or order finishes. Try the rename again once " +
					"those have been paid, cancelled or expired, usually a few minutes.",
			);
			expect(result.field, clause).toBe("sku");
		}
	});

	test("an operand the service did not send degrades to a phrase that still reads as a sentence", async () => {
		// Every one of these is unreachable while the service sends what it says it
		// sends — which is precisely why they are pinned: a degraded branch nobody
		// reads is where "Nothing was changed. that SKU already has…" ships.
		//
		// A HOLD COUNT IS NEVER GUESSED AT. `0` beside a refusal CAUSED by holds
		// reads as "no holds", which is the one thing the sentence must not say, so
		// the copy drops the figure and keeps the fact (absent is absent, CLAUDE.md).
		const cases: Array<[Record<string, unknown>, string]> = [
			[
				{ ok: false, reason: "SKU_HELD_STOCK", sku: "SKU-1" },
				'Nothing was changed: live reservations still hold units of "SKU-1", and',
			],
			[
				{ ok: false, reason: "SKU_HELD_STOCK", sku: "SKU-1", liveHolds: "many" },
				'Nothing was changed: live reservations still hold units of "SKU-1", and',
			],
			[
				{ ok: false, reason: "SKU_HELD_STOCK", liveHolds: 2 },
				"Nothing was changed: 2 live reservations still hold units of this SKU, and",
			],
			[
				{ ok: false, reason: "SKU_STOCK_CONFLICT", fromSku: "SKU-1" },
				"Nothing was changed. Stock is never merged between SKUs, and the SKU you asked for " +
					'already has its own inventory record — so "SKU-1" was not renamed onto it.',
			],
			[
				{ ok: false, reason: "SKU_STOCK_CONFLICT", toSku: "SKU-RETIRED" },
				'Nothing was changed. Stock is never merged between SKUs, and "SKU-RETIRED" already ' +
					"has its own inventory record — so this product's SKU was not renamed onto it.",
			],
		];
		for (const [body, opening] of cases) {
			service.respondWith("PATCH", () => ({ status: 409, body }));
			const result = await act("products:save-identity", { ...carrier, sku: "SKU-NEW" });
			const sentence = String(result.notice?.description);
			expect(sentence, JSON.stringify(body)).toContain(opening);
			expect(sentence, JSON.stringify(body)).not.toContain("0 live");
			// No empty quotes anywhere: a sku called nothing is not a fallback.
			expect(sentence, JSON.stringify(body)).not.toContain('""');
			expect(result.field, JSON.stringify(body)).toBe("sku");
		}
	});

	test("every OTHER outcome names no field at all — the top of the screen is still the default", async () => {
		// The plain edit path is untouched by the two refusals above: a save, a
		// stale watermark and the live-sku collision all still report where they
		// always did, and a screen reading `field` gets nothing to route on.
		const cases: Array<[number, Record<string, unknown>]> = [
			[200, { ok: true, updatedAt: UPDATED_AT }],
			[409, { reason: "STALE_EDIT", currentUpdatedAt: "2026-07-30T00:00:00.000Z" }],
			[409, { reason: "SKU_TAKEN", sku: "SKU-DUP" }],
			// The 400's own `field` is the SERVICE naming an out-of-range input, and it
			// is not this outcome's field: one names a value the domain rejected, the
			// other is where a sentence renders. Letting them cross would put the
			// price validator's copy beside the SKU input.
			[400, { field: "price" }],
			[404, {}],
		];
		for (const [status, body] of cases) {
			service.respondWith("PATCH", () => ({ status, body }));
			const result = await act("products:save-identity", { ...carrier, sku: "S-1" });
			expect(result.field, JSON.stringify(body)).toBeUndefined();
			expect(result.notice, JSON.stringify(body)).not.toBeNull();
		}
	});

	// -- restock (DA-4: one-shot, no staging) -----------------------------------

	test("a restock POSTs {qty} with BOTH tokens and a content-derived key (no nonce)", async () => {
		const result = await act("products:restock", {
			productId: PRODUCT_ID,
			onHand: "42",
			qty: "8",
		});
		const post = postTo("/restock");
		expect(post).toBeDefined();
		expect(post?.body).toEqual({ qty: 8 });
		// F-2a: `${productId}:${direction}:${onHandAtRender}:${qty}` — content plus
		// the watermark the operator saw.
		expect(header(post, "Idempotency-Key")).toBe(`${PRODUCT_ID}:restock:42:8`);
		expect(header(post, "X-Internal-Token")).toBe(ADMIN_TOKEN);
		expect(header(post, "X-Service-Token")).toBe(SERVICE_TOKEN);
		expect(result.notice?.variant).toBe("default");
		expect(result.notice?.title).toBe("Stock added");
		expect(String(result.notice?.description)).toContain("Added 8 units");
	});

	test("a restock does NOT re-read stock first — it is additive, and the watermark is only a key component", async () => {
		// The asymmetry with a removal is the point (DA-4 versus DA-3/DA-5): adding
		// stock cannot oversell anything, so it is one-shot. Its watermark buys
		// idempotency, not a staleness check, and pretending otherwise would put a
		// round trip on the cheap path.
		await act("products:restock", { productId: PRODUCT_ID, onHand: "42", qty: "8" });
		expect(service.requests.filter((r) => r.method === "GET")).toHaveLength(0);
	});

	test("a non-positive or non-integer restock quantity is refused at the boundary — nothing is POSTed", async () => {
		for (const qty of ["-4", "0", "1.5", "abc", ""]) {
			service.requests.length = 0;
			const result = await act("products:restock", { productId: PRODUCT_ID, onHand: "42", qty });
			expect(writes(), qty).toHaveLength(0);
			expect(result.notice?.variant, qty).toBe("error");
		}
	});

	test("THE REPLAY CASE: one rendered form submitted twice derives ONE key; a fresh watermark derives another", async () => {
		// The whole reason the key is content-derived rather than a nonce. A
		// double-click of the same control must dedupe, and two DELIBERATE restocks
		// of the same size must both apply — which they do because the second is
		// taken against the on-hand the first produced.
		let onHand = 42;
		const applied = new Map<string, number>();
		service.respondWith("POST", (request) => {
			const key = header(request, "Idempotency-Key") ?? "";
			const already = applied.get(key);
			if (already !== undefined) return { status: 200, body: { ok: true, onHand: already } };
			onHand += (request.body as { qty?: number } | undefined)?.qty ?? 0;
			applied.set(key, onHand);
			return { status: 200, body: { ok: true, onHand } };
		});

		await act("products:restock", { productId: PRODUCT_ID, onHand: "42", qty: "8" });
		const replay = await act("products:restock", { productId: PRODUCT_ID, onHand: "42", qty: "8" });
		const posts = service.requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(2);
		expect(header(posts[0], "Idempotency-Key")).toBe(header(posts[1], "Idempotency-Key"));
		// TWO requests, ONE movement: 42 + 8, and the replay is answered with the
		// same figure rather than 58.
		expect(onHand).toBe(50);
		expect(String(replay.notice?.description)).toContain("50");

		// A re-render reads the NEW on-hand, so the next submission carries a
		// different watermark ⇒ a different key ⇒ a second, deliberate restock.
		await act("products:restock", { productId: PRODUCT_ID, onHand: "50", qty: "8" });
		const all = service.requests.filter((r) => r.method === "POST");
		expect(header(all[2], "Idempotency-Key")).not.toBe(header(all[0], "Idempotency-Key"));
		expect(onHand).toBe(58);
	});

	// -- remove stock (the screen's ONE destructive act) ------------------------

	test("a removal re-reads live stock, then POSTs under the derived key", async () => {
		const result = await act("products:remove-stock", {
			productId: PRODUCT_ID,
			qty: "5",
			onHand: "42",
		});
		expect(service.requests.some((r) => r.method === "GET")).toBe(true);
		const post = postTo("/remove-stock");
		expect(post?.body).toEqual({ qty: 5 });
		expect(header(post, "Idempotency-Key")).toBe(`${PRODUCT_ID}:removal:42:5`);
		expect(result.notice?.variant).toBe("default");
		expect(result.notice?.title).toBe("Stock removed");
	});

	test("DA-3a: stock that moved since the operator saw it refuses the removal, names the new figure, and POSTs NOTHING", async () => {
		// THE GATE. The operator opened a confirm against 42; someone else removed
		// 12 in the meantime, so the dialog they read is already false. Nothing may
		// move, and the refusal has to say what the count is NOW — an operator who
		// is not told the new figure retries the same wrong amount.
		live.onHand = 30;
		const result = await act("products:remove-stock", {
			productId: PRODUCT_ID,
			qty: "10", // valid against the stale 42 AND against the live 30
			onHand: "42",
		});
		expect(writes()).toHaveLength(0);
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Stock changed — nothing was removed");
		expect(String(result.notice?.description)).toContain("30 units are on hand now");
	});

	test("DA-3a: a re-read carrying NO inventory record gets its own sentence, never a count of zero", async () => {
		// `null` is "this sku has no inventory record", which is not "0 units". A
		// refusal reading "0 units are on hand now" would state a count nobody took.
		live.onHand = null;
		const result = await act("products:remove-stock", {
			productId: PRODUCT_ID,
			qty: "5",
			onHand: "42",
		});
		expect(writes()).toHaveLength(0);
		expect(result.notice?.title).toBe("Stock changed — nothing was removed");
		expect(String(result.notice?.description)).toContain("no longer has an inventory record");
		expect(String(result.notice?.description)).not.toContain("0 units");
	});

	test("DA-3a is not opt-out: a removal payload with the watermark STRIPPED refuses, with no re-read at all", async () => {
		// An absent watermark has exactly two sources — a payload edited in
		// devtools, or a tab rendered before the watermark existed, which is
		// precisely the stale view DA-3a is for — and refusing is right for both.
		// The refusal happens BEFORE the re-read, because no re-read can supply a
		// watermark the operator never sent; tolerating it would remove the
		// staleness check entirely while looking like caution.
		for (const onHand of [undefined, "", "  ", "-1", "4.5", "abc"]) {
			service.requests.length = 0;
			const result = await act("products:remove-stock", {
				productId: PRODUCT_ID,
				qty: "5",
				...(onHand === undefined ? {} : { onHand }),
			});
			expect(service.requests, JSON.stringify(onHand)).toHaveLength(0);
			expect(result.notice?.title, JSON.stringify(onHand)).toBe("Not changed");
		}
	});

	test("a removal whose product could not be re-read applies NOTHING and says so", async () => {
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		const result = await act("products:remove-stock", {
			productId: PRODUCT_ID,
			qty: "5",
			onHand: "42",
		});
		expect(writes()).toHaveLength(0);
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Nothing was removed");
	});

	test("the SERVICE's guarded decrement still surfaces a clean refusal — never a negative", async () => {
		// The race the plugin's re-read cannot always catch: stock moves between the
		// re-read and the write. The service applies a guarded decrement and refuses
		// with the current count, and this is now the ONLY bound check on the path
		// (the client-side one lived on the unreached `-review` step — ADR-0015).
		live.onHand = 777;
		const result = await act("products:remove-stock", {
			productId: PRODUCT_ID,
			qty: "777",
			onHand: "777",
		});
		expect(postTo("/remove-stock")).toBeDefined();
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Not enough stock to remove");
		expect(String(result.notice?.description)).toContain("42");
	});

	test("a movement against a sku with no stock record names the state and the way out", async () => {
		service.respondWith("POST", () => ({
			status: 409,
			body: { ok: false, reason: "NO_INVENTORY_ROW" },
		}));
		const result = await act("products:restock", { productId: PRODUCT_ID, onHand: "42", qty: "1" });
		expect(result.notice?.title).toBe("No stock record yet");
		expect(String(result.notice?.description)).toContain("Re-save the SKU");
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

		live.onHand = 30;
		const refusal = await act("products:remove-stock", {
			productId: PRODUCT_ID,
			qty: "5",
			onHand: "42",
		});
		const ok = await act("products:restock", { productId: PRODUCT_ID, onHand: "42", qty: "1" });
		for (const outcome of [refusal, ok]) {
			expect(JSON.stringify(outcome)).not.toMatch(banned);
		}
	});
});
