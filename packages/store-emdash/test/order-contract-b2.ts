/**
 * The **staged** `OrderStore` contract suites for `EmdashOrderStore` — the INC-B2
 * slice of each, plus a named `test.todo` for every case a later increment owns.
 *
 * ## The one reason this copy exists
 *
 * The domain's suites are single functions that register EVERY case for the whole
 * port, and they import `test` from `vitest` themselves — so nothing outside them
 * can skip a case, and there is no per-case filter to pass. That is the whole of
 * the justification. It is NOT that the D1 tier cannot import domain contracts
 * (`test/d1/cart-store-contract.d1.spec.ts` imports `cartStoreContract` directly and
 * runs it in full), and it is NOT about the harness shapes, which this file takes
 * unchanged from `@otta-sh/domain/testing`.
 *
 * The `OrderStore` port is delivered across three increments (creation, transitions
 * and the hold intents in INC-B2; refunds, reconciliation resolution, fulfillment and
 * cancellation in INC-B3; the lists, search, customer view and outbox lease in
 * INC-B4). Registering all 68 cases at INC-B2 would have meant 46 failing cases on
 * every run, which is not a gate anyone reads. So the staging is explicit and
 * mechanical:
 *
 * INC-B3 has since un-todo'd 13 of them, by copying each body verbatim: the three
 * guarded `resolveReconciliation` cases, the four timeline cases that reach for
 * `recordFulfillment`/`cancelOrder`/the reconciliation pair, and the six transition
 * cases that count DELIVERED emails, which the email-outbox lease it landed made
 * servable. 33 todos remain, all INC-B4's.
 *
 * - the cases INC-B2 owns are copied from the domain suites and are **semantically
 *   verbatim**: the assertions, the fixtures and the titles are byte-for-byte, and
 *   the only edits are HELPER RENAMES forced by putting three suites in one module
 *   (`pendingInput` → `transitionPendingInput`/`timelinePendingInput`, `seed` →
 *   `seedTransitionOrder`, `drive` → `driveTransition`/`driveTimeline`, `dispatch` →
 *   `dispatchTransition`);
 * - every other case is registered as `test.todo("<original title> — lands in
 *   INC-B4")`, so the count of unbuilt behaviour is VISIBLE in the run output and the
 *   increment that owns it cannot quietly skip one;
 * - the method behind each todo throws `NotImplementedInIncrementError` naming the
 *   same increment — with ONE exception, the forced-rollback case, whose todo name
 *   says why it can never become a real case on a document store.
 *
 * **One todo's label deliberately differs from the increment its method belongs to.**
 * "resolveReconciliation clears the flag and records the disposition; state/lines
 * untouched" is labelled INC-B4 although `resolveReconciliation` is INC-B3's, because
 * the case ALSO calls `listOrders` to check the list badge: it cannot pass until the
 * later of the two lands, and labelling it B3 would tell that increment to un-todo a
 * case it cannot make green. The other three `resolveReconciliation` cases are
 * labelled INC-B3, which is why the two sets are not interchangeable.
 *
 * **This file is temporary and its end state is a deletion.** When INC-B4 lands the
 * last method, the three `.dialects.test.ts` files and the D1 spec call the domain
 * suites directly — as the cart and inventory suites already do — and this module and
 * its drift guard go away together. A copied case that has drifted from the domain's
 * own is therefore a bug in this file, never a local variant; the only edits it may
 * receive are DELETIONS. `test/order-contract-drift.test.ts` enforces exactly that by
 * reading the domain suites as text and asserting this file's active titles plus its
 * todo names cover their case set exactly.
 *
 * It is a plain module rather than a `.test.ts` so the D1 tier can import the same
 * slices without pulling in `describe-each-dialect.ts`, which imports
 * `better-sqlite3` and `pg` at module scope — neither of which exists inside
 * `workerd`.
 */
import {
	cancelOrder,
	cents,
	currency,
	getOrderTimeline,
	idempotencyKey,
	orderId,
	productId,
	recordFulfillment,
	reservationId,
	resolveReconciliation,
	sku,
	dispatchOrderEmails,
	transitionOrder,
	type AppendOrderNoteInput,
	type CreateOrderInput,
	type OrderId,
	type OrderState,
} from "@otta-sh/domain";
import type {
	OrderStoreHarness,
	OrderTimelineHarness,
	OrderTransitionHarness,
	SeedOrderSummaryRow,
} from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

const USD = currency("USD");

/** A summary-row seed with sensible defaults; overridable per admin-list case. */
function summaryRow(overrides: Partial<SeedOrderSummaryRow> & { id: string }): SeedOrderSummaryRow {
	return {
		state: "paid",
		currency: "USD",
		buyerRef: "buyer@example.com",
		createdAt: "2026-07-10T00:00:00.000Z",
		totalCents: 1000,
		...overrides,
	};
}

/** A valid `CreateOrderInput` with a single physical line; overridable per case. */
function physicalInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId("ord-1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

function transitionPendingInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId("ord-1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

async function seedTransitionOrder(
	h: OrderTransitionHarness,
	overrides?: Partial<CreateOrderInput>,
): Promise<OrderId> {
	const { order } = await h.store.createFromCart(transitionPendingInput(overrides));
	return order.id;
}

function driveTransition(h: OrderTransitionHarness, id: OrderId, to: OrderState) {
	return transitionOrder(
		{ orderStore: h.store },
		{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`t:${id}:${to}`) },
	);
}

function timelinePendingInput(
	id: string,
	key: string,
	overrides: Partial<CreateOrderInput> = {},
): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey(key),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

/** `dispatch` under the rename this module's three-suites-in-one-file forces. */
function dispatchTransition(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}

function driveTimeline(h: OrderTimelineHarness, id: OrderId, to: OrderState) {
	return transitionOrder(
		{ orderStore: h.orderStore },
		{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`t:${id}:${to}`) },
	);
}

function addNote(
	h: OrderTimelineHarness,
	input: Omit<AppendOrderNoteInput, "idempotencyKey"> & { key: string },
) {
	return h.orderNotesStore.append({
		orderId: input.orderId,
		author: input.author,
		body: input.body,
		idempotencyKey: idempotencyKey(input.key),
	});
}

/**
 * The staged slice of `orderStoreContract`: INC-B2's 14 creation / replay / snapshot /
 * transition / expiry cases plus INC-B3's 3 guarded-`resolveReconciliation` ones,
 * verbatim, and a named `todo` for each of the 30 that need a method INC-B4 owns.
 */
export function orderStoreContractB2(
	makeHarness: () => Promise<OrderStoreHarness>,
	opts: { dialect: string },
): void {
	describe(`orderStoreContract [${opts.dialect}] — INC-B2 slice`, () => {
		test("creates a pending order with line snapshots + the order_totals stub", async () => {
			const { store } = await makeHarness();
			const { created, order } = await store.createFromCart(physicalInput());
			expect(created).toBe(true);
			expect(order.state).toBe("pending");
			expect(order.lines).toHaveLength(1);
			const line = order.lines[0]!;
			expect(line.title).toBe("Widget");
			expect(line.unitPrice).toBe(500);
			expect(line.currency).toBe("USD");
			expect(line.quantity).toBe(3);
			expect(line.reservationId).toBe("res-1");
			expect(order.totals.subtotal).toBe(1500);
			expect(order.totals.total).toBe(1500);
			expect(order.totals.discount).toBe(0);
			expect(order.totals.shipping).toBe(0);
			expect(order.totals.tax).toBe(0);
		});

		test("creates an order with multiple distinct-sku lines; all persist and reload", async () => {
			const { store } = await makeHarness();
			const lines: CreateOrderInput["lines"] = [
				{
					productId: productId("p1"),
					sku: sku("SKU-1"),
					title: "Widget",
					unitPrice: cents(500),
					currency: USD,
					quantity: 3,
					fulfillmentKind: "physical",
					reservationId: reservationId("res-1"),
				},
				{
					productId: productId("p2"),
					sku: sku("SKU-2"),
					title: "Gadget",
					unitPrice: cents(1200),
					currency: USD,
					quantity: 1,
					fulfillmentKind: "physical",
					reservationId: reservationId("res-2"),
				},
				{
					productId: productId("p3"),
					sku: sku("SKU-3"),
					title: "Ebook",
					unitPrice: cents(999),
					currency: USD,
					quantity: 2,
					fulfillmentKind: "digital",
					reservationId: null,
				},
			];
			const { created, order } = await store.createFromCart(
				physicalInput({
					lines,
					totals: { subtotal: cents(4698), total: cents(4698), currency: USD },
				}),
			);
			expect(created).toBe(true);
			expect(order.lines).toHaveLength(3);

			// Order-insensitive assertion: the Kysely store loads order_items `ORDER BY
			// id` over RANDOM uuid ids while the fake preserves input order — so match
			// each expected line by sku, NEVER by positional index / array equality.
			const bySku = new Map(order.lines.map((l) => [l.sku, l]));
			expect([...bySku.keys()].toSorted()).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
			for (const expected of lines) {
				const got = bySku.get(expected.sku);
				expect(got).toBeDefined();
				expect(got?.productId).toBe(expected.productId);
				expect(got?.title).toBe(expected.title);
				expect(got?.unitPrice).toBe(expected.unitPrice);
				expect(got?.currency).toBe(expected.currency);
				expect(got?.quantity).toBe(expected.quantity);
				expect(got?.fulfillmentKind).toBe(expected.fulfillmentKind);
				expect(got?.reservationId).toBe(expected.reservationId);
			}
			// Every line got a distinct id (one `newId()` per line).
			expect(new Set(order.lines.map((l) => l.id)).size).toBe(3);

			// A reload returns the same membership (still order-insensitive).
			const reloaded = await store.getById(order.id);
			expect(reloaded?.lines.map((l) => l.sku).toSorted()).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
		});

		// -- ADR-0009: immutable ship-to snapshot on the order --------------------

		test("createFromCart freezes the submitted shipping address onto the order; a reload returns it", async () => {
			const { store } = await makeHarness();
			const { order } = await store.createFromCart(
				physicalInput({
					shippingAddress: {
						name: "Ada Lovelace",
						line1: "12 Analytical Way",
						line2: "Unit 4",
						city: "London",
						region: "Greater London",
						postalCode: "EC1A 1BB",
						country: "GB",
						email: "ada@example.com",
						phone: "+44 20 7946 0000",
					},
				}),
			);
			expect(order.shippingAddress).toEqual({
				name: "Ada Lovelace",
				line1: "12 Analytical Way",
				line2: "Unit 4",
				city: "London",
				region: "Greater London",
				postalCode: "EC1A 1BB",
				country: "GB",
				email: "ada@example.com",
				phone: "+44 20 7946 0000",
			});
			// The snapshot survives a fresh load (persisted, not just echoed).
			const reloaded = await store.getById(order.id);
			expect(reloaded?.shippingAddress?.name).toBe("Ada Lovelace");
			expect(reloaded?.shippingAddress?.country).toBe("GB");
		});

		test("createFromCart with the optional contact/line fields omitted stores them as null", async () => {
			const { store } = await makeHarness();
			const { order } = await store.createFromCart(
				physicalInput({
					shippingAddress: {
						name: "Grace Hopper",
						line1: "1 Navy Yard",
						line2: null,
						city: "Arlington",
						region: null,
						postalCode: "22202",
						country: "US",
						email: null,
						phone: null,
					},
				}),
			);
			const reloaded = await store.getById(order.id);
			expect(reloaded?.shippingAddress).toEqual({
				name: "Grace Hopper",
				line1: "1 Navy Yard",
				line2: null,
				city: "Arlington",
				region: null,
				postalCode: "22202",
				country: "US",
				email: null,
				phone: null,
			});
		});

		test("an order created without a shipping address has shippingAddress null (historical + digital parity)", async () => {
			const { store } = await makeHarness();
			const { order } = await store.createFromCart(physicalInput());
			expect(order.shippingAddress).toBeNull();
			expect((await store.getById(order.id))?.shippingAddress).toBeNull();
		});

		test("a replay carries the shipping address exactly once (idempotent snapshot)", async () => {
			const { store } = await makeHarness();
			const address = {
				name: "Ada Lovelace",
				line1: "12 Analytical Way",
				line2: null,
				city: "London",
				region: null,
				postalCode: "EC1A 1BB",
				country: "GB",
				email: null,
				phone: null,
			};
			const first = await store.createFromCart(physicalInput({ shippingAddress: address }));
			// A replay (same key, fresh orderId) returns the ORIGINAL order + its one
			// captured address — never a second row, never a rewrite.
			const replay = await store.createFromCart(
				physicalInput({ orderId: orderId("ord-2"), shippingAddress: address }),
			);
			expect(replay.created).toBe(false);
			expect(replay.order.id).toBe(first.order.id);
			expect(replay.order.shippingAddress).toEqual(address);
			expect((await store.getById(first.order.id))?.shippingAddress).toEqual(address);
		});

		test("getById returns the created order; an unknown id is null", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			const got = await store.getById(orderId("ord-1"));
			expect(got?.id).toBe("ord-1");
			expect(await store.getById(orderId("nope"))).toBeNull();
		});

		test("replay with the same idempotency_key returns the same order (created:false)", async () => {
			const { store } = await makeHarness();
			const first = await store.createFromCart(physicalInput());
			// A replay carries a DIFFERENT fresh orderId but the same key: the store
			// must dedupe on the key and return the ORIGINAL order.
			const replay = await store.createFromCart(physicalInput({ orderId: orderId("ord-2") }));
			expect(replay.created).toBe(false);
			expect(replay.order.id).toBe(first.order.id);
			expect(replay.order.lines).toHaveLength(1);
		});

		test("getByIdempotencyKey returns the order the key minted; an unknown key is null", async () => {
			const { store } = await makeHarness();
			const { order } = await store.createFromCart(physicalInput());
			const found = await store.getByIdempotencyKey(idempotencyKey("key-1"));
			expect(found?.id).toBe(order.id);
			expect(await store.getByIdempotencyKey(idempotencyKey("key-never-used"))).toBeNull();
		});

		test("order_items are insert-once: a re-read returns the exact price/title snapshot", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			const a = await store.getById(orderId("ord-1"));
			const b = await store.getById(orderId("ord-1"));
			expect(b?.lines[0]).toEqual(a?.lines[0]);
			expect(b?.lines[0]?.unitPrice).toBe(500);
			expect(b?.lines[0]?.title).toBe("Widget");
		});

		test("markPaid transitions pending→paid once; a second markPaid is a no-op (false)", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			expect(await store.markPaid(orderId("ord-1"))).toBe(true);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("paid");
			expect(await store.markPaid(orderId("ord-1"))).toBe(false);
		});

		test("markPaid on a failed order is rejected (illegal transition → false)", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			expect(await store.markFailed(orderId("ord-1"))).toBe(true);
			expect(await store.markPaid(orderId("ord-1"))).toBe(false);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("failed");
		});

		test("expire transitions pending→expired only when hold_expires_at<=now", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			// Not yet due:
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:10:00.000Z")).toBe(false);
			// Past the deadline:
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:20:00.000Z")).toBe(true);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("expired");
			// A double expire is a no-op.
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:20:00.000Z")).toBe(false);
		});

		test("listExpirable returns only pending past-TTL orders", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			await store.createFromCart(
				physicalInput({
					orderId: orderId("ord-2"),
					idempotencyKey: idempotencyKey("key-2"),
					holdExpiresAt: "2026-07-10T00:20:00.000Z",
				}),
			);
			await store.markPaid(orderId("ord-1")); // paid ⇒ never expirable
			const ids = await store.listExpirable("2026-07-10T00:30:00.000Z");
			expect(ids).toEqual([orderId("ord-2")]);
		});

		// -- Admin Orders console: view-only keyset list --------------------------

		test.todo("listOrders on an empty store returns no rows and a null cursor — lands in INC-B4");

		test.todo(
			"listOrders projects the summary fields (money as Cents, reconciliation as a boolean badge) — lands in INC-B4",
		);

		test.todo("listOrders filters by a single state — lands in INC-B4");

		test.todo("listOrders filters by multiple states (IN set) — lands in INC-B4");

		test.todo(
			"listOrders with no filter orders by created_at DESC, then id DESC — lands in INC-B4",
		);

		test.todo(
			"listOrders date window is half-open [from, to): from inclusive, to exclusive — lands in INC-B4",
		);

		test.todo(
			"listOrders search matches an order-id PREFIX, and a whole id (its own prefix) — lands in INC-B4",
		);

		test.todo(
			"listOrders search folds the id prefix on BOTH sides (ids are lowercase hex) — lands in INC-B4",
		);

		test.todo(
			"listOrders search matches a buyer_ref SUBSTRING, case-folded on both sides — lands in INC-B4",
		);

		test.todo(
			"listOrders search treats `%` and `_` as LITERAL characters, never wildcards — lands in INC-B4",
		);

		test.todo(
			"listOrders search treats `\\` — the ESCAPE character itself — LITERALLY — lands in INC-B4",
		);

		test.todo(
			"listOrders search of the EMPTY string matches every order (it constrains nothing) — lands in INC-B4",
		);

		test.todo(
			"listOrders search matches a purchase-time LINE SKU, folded but EXACT — lands in INC-B4",
		);

		test.todo(
			"listOrders returns a MULTI-LINE order matching on sku exactly ONCE — lands in INC-B4",
		);

		test.todo(
			"listOrders search reads the FROZEN sku — a later rename never moves an old order — lands in INC-B4",
		);

		test.todo(
			"listOrders search treats a sku's `%`/`_`/`\\` as LITERAL characters — lands in INC-B4",
		);

		test.todo(
			"listOrders search UNIONS its arms — one string, one order by id, another by sku — lands in INC-B4",
		);

		test.todo("countOrders counts under the SAME search predicate as listOrders — lands in INC-B4");

		test.todo(
			"listOrders paginates forward with a keyset cursor — no overlap, no gap — lands in INC-B4",
		);

		test.todo(
			"listOrders keyset tie-break is stable across a page boundary on identical created_at — lands in INC-B4",
		);

		test.todo(
			"listOrders with rows exactly equal to the limit returns a null cursor (no phantom page) — lands in INC-B4",
		);

		test.todo(
			"listOrders customer key UNIONS customer_id and buyer_ref: linked + not-yet-relinked, never a foreign order — lands in INC-B4",
		);

		test.todo(
			"listOrders customer key: an order matching BOTH halves appears exactly once — lands in INC-B4",
		);

		test.todo(
			"listOrders customer.buyerRef folds case but stays EXACT — it does NOT follow search's substring — lands in INC-B4",
		);

		test.todo(
			"listOrders customer key with a single half set filters on that half alone — lands in INC-B4",
		);

		test.todo(
			"listOrders customer key ANDs with the states filter (union inside the key only) — lands in INC-B4",
		);

		test.todo(
			"countOrders agrees with listOrders on the union customer key (and counts a both-halves order once) — lands in INC-B4",
		);

		test.todo("countOrders on a customer with no orders returns 0 — lands in INC-B4");

		test.todo(
			"countOrders applies the full listOrders predicate (states AND window AND customer) — lands in INC-B4",
		);

		test.todo(
			"resolveReconciliation clears the flag and records the disposition; state/lines untouched — lands in INC-B4",
		);

		test("resolveReconciliation with a STALE expectedFlag is a 0-row miss: the re-flagged anomaly survives", async () => {
			const h = await makeHarness();
			// The admin reviewed "commit lost" — but a NEW anomaly re-flagged the order
			// before they submitted. The equality guard must NOT clear the new flag.
			await h.seedOrder(
				summaryRow({ id: "ord-stale", state: "paid", reconciliationFlag: "paid flip lost" }),
			);
			const res = await h.store.resolveReconciliation({
				orderId: orderId("ord-stale"),
				expectedFlag: "commit lost", // stale — the displayed flag, not the live one
				outcome: "written_off",
				reason: "reviewed the old anomaly",
				resolvedBy: "ops@shop.test",
				idempotencyKey: idempotencyKey("res-stale"),
			});
			expect(res.resolved).toBe(false);
			const after = await h.store.getById(orderId("ord-stale"));
			// The LIVE flag is untouched and no disposition was fabricated.
			expect(after?.reconciliationFlag).toBe("paid flip lost");
			expect(after?.reconciliationResolution).toBeNull();
		});

		test("resolveReconciliation on a NON-flagged order is a guarded 0-row no-op (resolved:false)", async () => {
			const h = await makeHarness();
			await h.seedOrder(summaryRow({ id: "ord-clean", state: "paid" })); // no flag
			const res = await h.store.resolveReconciliation({
				orderId: orderId("ord-clean"),
				expectedFlag: "anything",
				outcome: "written_off",
				reason: "n/a",
				resolvedBy: "ops@shop.test",
				idempotencyKey: idempotencyKey("res-2"),
			});
			expect(res.resolved).toBe(false);
			const after = await h.store.getById(orderId("ord-clean"));
			// Nothing recorded — a resolve never fabricates a disposition on a clean order.
			expect(after?.reconciliationResolution).toBeNull();
		});

		test("resolveReconciliation is once-only: a second resolve is a 0-row no-op, disposition unchanged", async () => {
			const h = await makeHarness();
			await h.seedOrder(
				summaryRow({ id: "ord-once", state: "paid", reconciliationFlag: "paid flip lost" }),
			);
			const first = await h.store.resolveReconciliation({
				orderId: orderId("ord-once"),
				expectedFlag: "paid flip lost",
				outcome: "refunded",
				reason: "refunded the buyer, stock was gone",
				resolvedBy: "alice",
				idempotencyKey: idempotencyKey("res-3a"),
			});
			expect(first.resolved).toBe(true);
			// A second, different resolve attempt finds the flag already cleared.
			const second = await h.store.resolveReconciliation({
				orderId: orderId("ord-once"),
				expectedFlag: "paid flip lost",
				outcome: "written_off",
				reason: "different call",
				resolvedBy: "bob",
				idempotencyKey: idempotencyKey("res-3b"),
			});
			expect(second.resolved).toBe(false);
			// The FIRST disposition is authoritative — the loser never overwrote it.
			const after = await h.store.getById(orderId("ord-once"));
			expect(after?.reconciliationResolution?.outcome).toBe("refunded");
			expect(after?.reconciliationResolution?.resolvedBy).toBe("alice");
		});
	});
}

/**
 * The staged slice of `orderTransitionContract`: INC-B2's two table cases plus the
 * six INC-B3 made servable by landing the email-outbox lease, verbatim.
 *
 * Three todos remain, and none of them is about a transition: two need `listOrders`/
 * `linkGuestOrders` (the lists increment), and the forced-rollback case needs a
 * `forceFailedTransition` hook the document harness deliberately does not have —
 * there is no transaction to abort here, so a green would be vacuous. The property
 * that case exists to prove is pinned instead by
 * `order-crash-seams.dialects.test.ts`, which PARKS the single compare-and-set and
 * asserts neither the state change nor the outbox row has landed.
 */
export function orderTransitionContractB2(
	makeHarness: () => Promise<OrderTransitionHarness>,
	opts: { dialect: string },
): void {
	describe(`orderTransitionContract [${opts.dialect}] — INC-B2 slice`, () => {
		test("pending → paid transitions once and enqueues exactly one order-confirmation email", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			const res = await driveTransition(h, id, "paid");
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.transitioned).toBe(true);
			expect((await h.store.getById(id))?.state).toBe("paid");
			expect(await dispatchTransition(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", id)).toBe(1);
		});

		test("paid → processing enqueues exactly one order-processing email", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			await driveTransition(h, id, "paid");
			await dispatchTransition(h); // drain the confirmation email
			const res = await driveTransition(h, id, "processing");
			expect(res.ok).toBe(true);
			await dispatchTransition(h);
			expect(h.emailSender.countByTemplate("order-processing", id)).toBe(1);
		});

		test("the full fulfillment path transitions each step exactly once", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			for (const to of ["paid", "processing", "shipped", "delivered", "completed"] as const) {
				const res = await driveTransition(h, id, to);
				expect(res.ok).toBe(true);
				if (res.ok) expect(res.transitioned).toBe(true);
			}
			expect((await h.store.getById(id))?.state).toBe("completed");
		});

		test("pending → shipped is rejected INVALID_TRANSITION and enqueues zero emails", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			const res = await driveTransition(h, id, "shipped");
			expect(res).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
			expect((await h.store.getById(id))?.state).toBe("pending");
			expect(await dispatchTransition(h)).toBe(0);
			expect(h.emailSender.sends).toHaveLength(0);
		});

		test("a Phase-5 state cannot hop back into a Phase-4 state (paid → pending / paid → expired rejected)", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			await driveTransition(h, id, "paid");
			expect(await driveTransition(h, id, "pending")).toEqual({
				ok: false,
				reason: "INVALID_TRANSITION",
			});
			expect(await driveTransition(h, id, "expired")).toEqual({
				ok: false,
				reason: "INVALID_TRANSITION",
			});
			expect((await h.store.getById(id))?.state).toBe("paid");
		});

		test("pending → expired is accepted (Phase-4-authoritative) and enqueues exactly one order-expired email", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			const res = await driveTransition(h, id, "expired");
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.transitioned).toBe(true);
			expect((await h.store.getById(id))?.state).toBe("expired");
			expect(await dispatchTransition(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-expired", id)).toBe(1);
		});

		test("replaying the same transition is a no-op and sends exactly one email (headline 5)", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			const first = await driveTransition(h, id, "paid");
			const replay = await driveTransition(h, id, "paid");
			expect(first.ok).toBe(true);
			expect(replay.ok).toBe(true);
			if (replay.ok) expect(replay.transitioned).toBe(false); // already paid ⇒ no-op
			expect(await dispatchTransition(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", id)).toBe(1);
		});

		test("pending → cancelled sends exactly one order-cancelled email", async () => {
			const h = await makeHarness();
			const id = await seedTransitionOrder(h);
			await driveTransition(h, id, "cancelled");
			await dispatchTransition(h);
			expect(h.emailSender.countByTemplate("order-cancelled", id)).toBe(1);
		});

		test.todo(
			"listForCustomer returns only that customer's orders (headline 1) — lands in INC-B4 (needs listForCustomer)",
		);

		test.todo(
			"linkGuestOrders matches buyer_ref case-insensitively — a mixed-case guest checkout still links (H2) — lands in INC-B4 (needs linkGuestOrders, which also rewrites customerKey)",
		);

		// NOT a lease gap and not deferred work: the document harness has no
		// `forceFailedTransition` because there is no transaction to abort, so a green
		// here would be vacuous. `order-crash-seams.dialects.test.ts` parks the single
		// compare-and-set and asserts the same property instead — which is why this
		// todo's suffix says NOT COVERAGE rather than naming an increment that will
		// come back for it.
		test.todo(
			"a forced rollback mid-transition leaves neither the state change nor the outbox row — not coverage: no transaction to abort on a document store, pinned by order-crash-seams instead",
		);
	});
}

/** The staged slice of `orderTimelineContract`: INC-B2's six cases (the state-change
 *  audit spine plus the notes merge) and INC-B3's four (the fulfillment, cancellation
 *  and reconciliation artifacts) — the whole suite, with no todo left. */
export function orderTimelineContractB2(
	makeHarness: () => Promise<OrderTimelineHarness>,
	opts: { dialect: string },
): void {
	describe(`orderTimelineContract [${opts.dialect}] — INC-B2 slice`, () => {
		test("each guarded state flip records exactly one state_change event (from/to/actor)", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-1");
			await h.orderStore.createFromCart(timelinePendingInput("ord-audit-1", "key-a1"));
			h.tick(1000);
			await driveTimeline(h, id, "paid");
			h.tick(1000);
			await driveTimeline(h, id, "processing");
			h.tick(1000);
			await recordFulfillment(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					carrier: "UPS",
					trackingNumber: "1Z-1",
					recordedBy: "dispatch-desk",
					idempotencyKey: idempotencyKey(`f:${id}`),
				},
			);

			const events = await h.orderStore.listEventsForOrder(id);
			expect(events.map((e) => [e.fromState, e.toState])).toEqual([
				["pending", "paid"],
				["paid", "processing"],
				["processing", "shipped"],
			]);
			// Bare transitions carry no modeled actor; the fulfillment flip stamps the
			// recorder as its actor.
			expect(events.map((e) => e.actor)).toEqual([null, null, "dispatch-desk"]);
			expect(events.every((e) => e.kind === "state_change")).toBe(true);
			// createFromCart is NOT a flip — creation is derived, never an event.
			expect(events).toHaveLength(3);
		});

		test("a replayed transition records no duplicate event (a 0-row flip audits nothing)", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-2");
			await h.orderStore.createFromCart(timelinePendingInput("ord-audit-2", "key-a2"));
			// markPaid twice: the first wins (pending→paid), the second is a 0-row miss.
			expect(await h.orderStore.markPaid(id)).toBe(true);
			expect(await h.orderStore.markPaid(id)).toBe(false);
			const events = await h.orderStore.listEventsForOrder(id);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ fromState: "pending", toState: "paid" });
		});

		test("cancel records a cancelled state_change event with the canceller as actor", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-3");
			await h.orderStore.createFromCart(timelinePendingInput("ord-audit-3", "key-a3"));
			await cancelOrder(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					reason: "customer_request",
					detail: null,
					cancelledBy: "ops@shop",
					idempotencyKey: idempotencyKey(`c:${id}`),
				},
			);
			const events = await h.orderStore.listEventsForOrder(id);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				fromState: "pending",
				toState: "cancelled",
				actor: "ops@shop",
			});
		});

		test("expire records an expired state_change event", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-4");
			await h.orderStore.createFromCart(timelinePendingInput("ord-audit-4", "key-a4"));
			// The hold deadline is in the past relative to this `now`.
			expect(await h.orderStore.expire(id, "2026-07-10T01:00:00.000Z")).toBe(true);
			const events = await h.orderStore.listEventsForOrder(id);
			expect(events.map((e) => e.toState)).toEqual(["expired"]);
		});

		test("events are scoped to one order — another order's events never leak in", async () => {
			const h = await makeHarness();
			await h.orderStore.createFromCart(timelinePendingInput("ord-A", "key-A"));
			await h.orderStore.createFromCart(timelinePendingInput("ord-B", "key-B"));
			await h.orderStore.markPaid(orderId("ord-A"));
			const a = await h.orderStore.listEventsForOrder(orderId("ord-A"));
			const b = await h.orderStore.listEventsForOrder(orderId("ord-B"));
			expect(a.map((e) => e.toState)).toEqual(["paid"]);
			expect(b).toEqual([]);
		});

		test("the timeline merges the created moment, state changes, and notes in chronological order", async () => {
			const h = await makeHarness();
			const id = orderId("ord-tl-1");
			await h.orderStore.createFromCart(timelinePendingInput("ord-tl-1", "key-tl1")); // created @ T0
			h.tick(1000);
			await addNote(h, { orderId: id, author: "alice", body: "gift-wrap please", key: "n1" }); // @ T1
			h.tick(1000);
			await driveTimeline(h, id, "paid"); // @ T2
			h.tick(1000);
			await addNote(h, { orderId: id, author: "bob", body: "called back", key: "n2" }); // @ T3

			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			expect(timeline).not.toBeNull();
			expect(timeline?.entries.map((e) => e.kind)).toEqual([
				"created",
				"note",
				"state_change",
				"note",
			]);
			expect(timeline?.stateChangesAudited).toBe(true);
			// The bodies/states land on the right entries.
			const kinds = timeline?.entries ?? [];
			expect(kinds[1]).toMatchObject({ kind: "note", author: "alice" });
			expect(kinds[2]).toMatchObject({ kind: "state_change", toState: "paid" });
			expect(kinds[3]).toMatchObject({ kind: "note", author: "bob" });
		});

		test("the timeline places the fulfillment, cancellation, and reconciliation artifacts at their timestamps", async () => {
			const h = await makeHarness();
			const id = orderId("ord-tl-2");
			await h.orderStore.createFromCart(timelinePendingInput("ord-tl-2", "key-tl2"));
			h.tick(1000);
			await driveTimeline(h, id, "paid");
			h.tick(1000);
			await driveTimeline(h, id, "processing");
			h.tick(1000);
			await recordFulfillment(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					carrier: "DHL",
					trackingNumber: "DH-9",
					recordedBy: "shipper",
					idempotencyKey: idempotencyKey(`f:${id}`),
				},
			);

			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			const entries = timeline?.entries ?? [];
			// created, →paid, →processing, →shipped, then the fulfillment detail (same
			// instant as the shipped flip — the state_change sorts before it).
			expect(entries.map((e) => e.kind)).toEqual([
				"created",
				"state_change",
				"state_change",
				"state_change",
				"fulfillment",
			]);
			expect(entries.at(-1)).toMatchObject({
				kind: "fulfillment",
				carrier: "DHL",
				recordedBy: "shipper",
			});
			expect(entries[3]).toMatchObject({ kind: "state_change", toState: "shipped" });
		});

		test("a historical order (no events) still yields a partial timeline and degrades gracefully", async () => {
			const h = await makeHarness();
			const id = orderId("ord-hist");
			await h.orderStore.createFromCart(timelinePendingInput("ord-hist", "key-hist"));
			// Flag then resolve reconciliation — a resolve is NOT a state flip, so it
			// records no event; the order thus has zero state_change events.
			await h.orderStore.flagReconciliation(id, "commit lost for reservation res-1");
			h.tick(1000);
			await resolveReconciliation(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					expectedFlag: "commit lost for reservation res-1",
					outcome: "written_off",
					reason: "false alarm",
					resolvedBy: "ops@shop",
					idempotencyKey: idempotencyKey(`rr:${id}`),
				},
			);
			h.tick(1000);
			await addNote(h, { orderId: id, author: "ops", body: "closed out", key: "n-h" });

			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			expect(timeline?.stateChangesAudited).toBe(false);
			expect(timeline?.entries.map((e) => e.kind)).toEqual([
				"created",
				"reconciliation_resolved",
				"note",
			]);
			expect(timeline?.entries[1]).toMatchObject({
				kind: "reconciliation_resolved",
				outcome: "written_off",
				resolvedBy: "ops@shop",
			});
		});

		test("same-instant entries keep a deterministic order via the kind rank", async () => {
			// No tick: creation, the note, and the paid flip all share T0. The kind
			// rank orders them created < state_change < note regardless of iteration.
			const h = await makeHarness();
			const id = orderId("ord-tie");
			await h.orderStore.createFromCart(timelinePendingInput("ord-tie", "key-tie"));
			await addNote(h, { orderId: id, author: "a", body: "note at T0", key: "n-tie" });
			await h.orderStore.markPaid(id);
			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			expect(timeline?.entries.map((e) => e.kind)).toEqual(["created", "state_change", "note"]);
		});

		test("getOrderTimeline returns null for a missing order", async () => {
			const h = await makeHarness();
			expect(
				await getOrderTimeline(
					{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
					orderId("nope"),
				),
			).toBeNull();
		});
	});
}
