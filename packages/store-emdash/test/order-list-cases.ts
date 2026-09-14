/**
 * The document model's OWN statements about the admin list, the search, the customer
 * union and the outbox locator — the ones the port's contract cannot make because they
 * are about the shape underneath it.
 *
 * The domain suite already pins the port's behaviour on every adapter. What it cannot
 * see is that this adapter serves an OR-free filter algebra by MERGING arms, that the
 * search's line-sku arm is a second collection of derived documents, that the keyset
 * cursor is re-derived from the port's own value position rather than round-tripped
 * through the host's opaque token, and that the outbox settle path now goes through a
 * locator document instead of walking an index. Each of those is a decision that can
 * regress silently while every contract case stays green, so each gets a case here:
 *
 * - **one row per order under a multi-line sku match**, with `countOrders` agreeing —
 *   the index's document id is the `(sku, orderId)` pair, so this is structural;
 * - **a DELETED cursor row is not a paging fault.** The host's own cursor seeks by
 *   RE-READING the cursor row (`select … where id = :cursorId`), so deleting that row
 *   breaks the seek. The adapter therefore ignores the host token across calls and
 *   re-derives the position from the port's `{ createdAt, id }`, which describes itself.
 *   No such case existed anywhere in the tree (ADR-0019 §6.3);
 * - **the search narrowing, stated as a test.** An id PREFIX matches; a mid-string
 *   buyer-reference fragment matches NOTHING. That is the user-visible narrowing
 *   ADR-0019 §6.1 ratified, and it is pinned here so it is a decision rather than a bug;
 * - **the customer key is a UNION of two indexed arms**, and `countOrders` takes it by
 *   inclusion–exclusion — so an order matching both halves is counted once;
 * - **`linkGuestOrders` rewrites `customerKey`**, or the customer filter would stop
 *   finding an order the moment it was linked (ADR-0019 R3);
 * - **the by-sku index heals idempotently**: a deleted index document is rebuilt by a
 *   replay, and rebuilt ONCE;
 * - **the locator**: a settle finds its entry by id with no index walk, and a settle of
 *   an already-drained entry is a no-op.
 *
 * It is a plain module rather than a `.test.ts` for the same reason
 * `order-cancellation-release.ts` is: D1's spec cannot import a `.dialects.test.ts`,
 * which pulls in `better-sqlite3` and `pg` at module scope.
 */
import {
	cents,
	currency,
	customerId as brandCustomerId,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku as brandSku,
	type CreateOrderInput,
	type OrderStore,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	foldSku,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	ORDERS_COLLECTION,
	OUTBOX_KEYS_COLLECTION,
	type OrderDoc,
	type OrderSkuIndexDoc,
	type OutboxKeyDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

const USD = currency("USD");

/** An order carrying REAL frozen lines, through the port's own `createFromCart`. */
async function lined(
	store: OrderStore,
	input: { id: string; skus: readonly string[]; buyerRef?: string },
): Promise<void> {
	const unit = 500;
	const lines: CreateOrderInput["lines"] = input.skus.map((s, i) => ({
		productId: productId(`p-${input.id}-${String(i)}`),
		sku: brandSku(s),
		title: "Widget",
		unitPrice: cents(unit),
		currency: USD,
		quantity: 1,
		fulfillmentKind: "physical",
		reservationId: reservationId(`res-${input.id}-${String(i)}`),
	}));
	const total = cents(unit * input.skus.length);
	await store.createFromCart({
		orderId: orderId(input.id),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey(`key-${input.id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: input.buyerRef ?? "buyer@example.com",
		paymentMethod: "stripe",
		lines,
		totals: { subtotal: total, total, currency: USD },
	});
}

/** A bare seeded order at an exact instant. */
function seed(
	h: OrderHarness,
	id: string,
	overrides: { createdAt?: string; buyerRef?: string; customerId?: string | null } = {},
): Promise<void> {
	return h.seedOrder({
		id,
		state: "paid",
		currency: "USD",
		buyerRef: overrides.buyerRef ?? "buyer@example.com",
		createdAt: overrides.createdAt ?? "2026-07-10T00:00:00.000Z",
		totalCents: 1000,
		...(overrides.customerId === undefined ? {} : { customerId: overrides.customerId }),
	});
}

/**
 * Register the document-model list cases against a bound `StorageAccess`.
 *
 * A THUNK, not a value: `describe-each-dialect`'s binding is only valid inside a test,
 * so every case reads the storage when it runs.
 */
export function orderListCases(storage: () => StorageAccess): void {
	const skuIndex = (): StorageCollection<OrderSkuIndexDoc> =>
		collectionOf<OrderSkuIndexDoc>(storage(), ORDER_SKU_INDEX_COLLECTION);
	const outboxKeys = (): StorageCollection<OutboxKeyDoc> =>
		collectionOf<OutboxKeyDoc>(storage(), OUTBOX_KEYS_COLLECTION);
	const orders = (): StorageCollection<OrderDoc> =>
		collectionOf<OrderDoc>(storage(), ORDERS_COLLECTION);

	test("a multi-line sku match is ONE index document, one row and one count", async () => {
		const h = makeOrderHarness(storage());
		// Three lines, two of them the same sku — the shape a join onto the lines would
		// return twice. The index's document id is the (sku, orderId) PAIR, so the
		// de-duplication is structural rather than a step that could be forgotten.
		await lined(h.store, { id: "ord-dup", skus: ["SKU-DUP", "SKU-DUP", "SKU-OTHER"] });
		const index = skuIndex();
		expect(await index.get(orderSkuIndexId(foldSku("SKU-DUP"), "ord-dup"))).toEqual({
			sku: "sku-dup",
			orderId: "ord-dup",
			// The order's own frozen createdAt, copied so the arm can be a keyset arm.
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		// Two distinct skus on the order ⇒ exactly two index documents, not three.
		expect((await index.query({ where: { sku: "sku-dup" }, limit: 100 })).items).toHaveLength(1);
		const page = await h.store.listOrders({ search: "SKU-DUP" }, { limit: 25 });
		expect(page.orders.map((o) => o.id)).toEqual(["ord-dup"]);
		expect(await h.store.countOrders({ search: "SKU-DUP" })).toBe(1);
	});

	test("a DELETED cursor row is not a paging fault: the position describes itself", async () => {
		const h = makeOrderHarness(storage());
		await seed(h, "o1", { createdAt: "2026-07-10T00:00:01.000Z" });
		await seed(h, "o2", { createdAt: "2026-07-10T00:00:02.000Z" });
		await seed(h, "o3", { createdAt: "2026-07-10T00:00:03.000Z" });
		const page1 = await h.store.listOrders({}, { limit: 2 });
		expect(page1.orders.map((o) => o.id)).toEqual(["o3", "o2"]);
		expect(page1.nextCursor).toEqual({ createdAt: "2026-07-10T00:00:02.000Z", id: "o2" });

		// The row the cursor names is DELETED between the two pages. The host's own
		// cursor seeks by re-reading that row, so a round-tripped host token would have
		// nothing to compare against; the port's value position still does.
		expect(await orders().delete("o2")).toBe(true);
		const page2 = await h.store.listOrders({}, { limit: 2, cursor: page1.nextCursor });
		expect(page2.orders.map((o) => o.id)).toEqual(["o1"]);
		expect(page2.nextCursor).toBeNull();
	});

	test("the search narrowing, stated: a buyer_ref PREFIX matches, a MID-STRING one does not", async () => {
		const h = makeOrderHarness(storage());
		await seed(h, "ord-narrow", { buyerRef: "Buyer@Example.com" });
		// The id arm survives intact — anchored, folded on both sides.
		expect((await h.store.listOrders({ search: "ORD-NAR" }, { limit: 25 })).orders).toHaveLength(1);
		expect(await h.store.countOrders({ search: "ord-narrow" })).toBe(1);
		// The buyer-reference arm is served as a PREFIX, folded on both sides: the whole
		// address, and the local part an operator actually types, both find the order. That
		// is the workflow the arm exists for, and it is why the narrowing is a prefix rather
		// than a removal.
		expect(
			(await h.store.listOrders({ search: "buyer@example.com" }, { limit: 25 })).orders.map(
				(o) => o.id,
			),
		).toEqual(["ord-narrow"]);
		expect((await h.store.listOrders({ search: "BUY" }, { limit: 25 })).orders).toHaveLength(1);
		expect(await h.store.countOrders({ search: "buyer@example.com" })).toBe(1);
		// THE NARROWING, stated as an assertion. The port documents an UNANCHORED substring;
		// the filter algebra has no substring operator and no OR to hang a second one off,
		// so a MID-STRING fragment — a domain, anything after the first character — reaches
		// nothing. Documented in the README and in the screen's empty state; widening it
		// back out is a [Domain] change.
		expect((await h.store.listOrders({ search: "example.com" }, { limit: 25 })).orders).toEqual([]);
		expect(await h.store.countOrders({ search: "example.com" })).toBe(0);
		// And a metacharacter is a CHARACTER, never a wildcard — the host escapes the prefix
		// before it builds the LIKE. So a bare `%` matches the address that starts with one,
		// which is nothing here, rather than matching everything.
		expect((await h.store.listOrders({ search: "%" }, { limit: 25 })).orders).toEqual([]);
		// The EMPTY search stays the widest filter, because every string starts with "".
		expect((await h.store.listOrders({ search: "" }, { limit: 25 })).orders).toHaveLength(1);
	});

	test("a page boundary inside a createdAt TIE GROUP is code-unit ordered, not collation ordered", async () => {
		const h = makeOrderHarness(storage());
		const at = "2026-07-10T00:00:07.000Z";
		// Four orders at ONE instant, with deliberately non-uniform ids. Under the adapter's
		// total order (`id DESC` in CODE-UNIT order) `-` (0x2D) sorts below every letter, so
		// the order is oa, o-d, o-c, o-b. Under Postgres's default collation punctuation is
		// ignored at the primary level, so the HOST returns od, oc, ob, oa — a different
		// sequence. Paging one row at a time is what makes the difference observable: an arm
		// that truncated at `need` in the host's order would drop a tied row off one page
		// without it appearing on the next.
		for (const id of ["oa", "o-b", "o-c", "o-d"]) await seed(h, id, { createdAt: at });
		const seen: string[] = [];
		let cursor = null as Awaited<ReturnType<typeof h.store.listOrders>>["nextCursor"];
		for (let page = 0; page < 5; page++) {
			const result = await h.store.listOrders(
				{},
				{ limit: 1, ...(cursor === null ? {} : { cursor }) },
			);
			seen.push(...result.orders.map((o) => o.id));
			cursor = result.nextCursor;
			if (cursor === null) break;
		}
		expect(seen).toEqual(["oa", "o-d", "o-c", "o-b"]);
		expect(cursor).toBeNull();
		expect(await h.store.countOrders({})).toBe(4);
	});

	test("a customer union pages correctly when each arm reaches different orders", async () => {
		const h = makeOrderHarness(storage());
		// Two orders reachable ONLY through `customerKey` (linked, and their buyer reference
		// is somebody else's) and two ONLY through `buyerRefLower` (one guest, one linked to
		// a DIFFERENT customer — R3's edge). Interleaved by createdAt, so no page can be
		// served by one arm alone.
		await seed(h, "u1", {
			createdAt: "2026-07-10T00:00:01.000Z",
			customerId: "cust-1",
			buyerRef: "other@x.test",
		});
		await seed(h, "u2", {
			createdAt: "2026-07-10T00:00:02.000Z",
			customerId: null,
			buyerRef: "bob@example.com",
		});
		await seed(h, "u3", {
			createdAt: "2026-07-10T00:00:03.000Z",
			customerId: "cust-1",
			buyerRef: "zed@x.test",
		});
		await seed(h, "u4", {
			createdAt: "2026-07-10T00:00:04.000Z",
			customerId: "cust-9",
			buyerRef: "Bob@Example.com",
		});
		const key = { customerId: "cust-1", buyerRef: "bob@example.com" };
		const page1 = await h.store.listOrders({ customer: key }, { limit: 2 });
		expect(page1.orders.map((o) => o.id)).toEqual(["u4", "u3"]);
		expect(page1.nextCursor).not.toBeNull();
		const page2 = await h.store.listOrders(
			{ customer: key },
			{ limit: 2, cursor: page1.nextCursor },
		);
		expect(page2.orders.map((o) => o.id)).toEqual(["u2", "u1"]);
		expect(page2.nextCursor).toBeNull();
		// No overlap, no gap: the pages concatenate to the full DESC order, and the count
		// agrees with what the pages contained.
		expect([...page1.orders, ...page2.orders].map((o) => o.id)).toEqual(["u4", "u3", "u2", "u1"]);
		expect(await h.store.countOrders({ customer: key })).toBe(4);
	});

	test("a search pages correctly when the id arm and the sku arm reach different orders", async () => {
		const h = makeOrderHarness(storage());
		// Alternating: an order the ID arm finds (its id starts with the search), then one
		// only the SKU arm finds, and so on — each a second apart so the merge has to
		// interleave the two arms rather than concatenate them.
		await lined(h.store, { id: "sku-x-1", skus: ["OTHER-1"] });
		h.advance(1000);
		await lined(h.store, { id: "ord-b", skus: ["SKU-X"] });
		h.advance(1000);
		await lined(h.store, { id: "sku-x-3", skus: ["OTHER-3"] });
		h.advance(1000);
		await lined(h.store, { id: "ord-d", skus: ["SKU-X"] });
		const page1 = await h.store.listOrders({ search: "SKU-X" }, { limit: 2 });
		expect(page1.orders.map((o) => o.id)).toEqual(["ord-d", "sku-x-3"]);
		expect(page1.nextCursor).not.toBeNull();
		const page2 = await h.store.listOrders(
			{ search: "SKU-X" },
			{ limit: 2, cursor: page1.nextCursor },
		);
		expect(page2.orders.map((o) => o.id)).toEqual(["ord-b", "sku-x-1"]);
		expect(page2.nextCursor).toBeNull();
		expect([...page1.orders, ...page2.orders].map((o) => o.id)).toEqual([
			"ord-d",
			"sku-x-3",
			"ord-b",
			"sku-x-1",
		]);
		expect(await h.store.countOrders({ search: "SKU-X" })).toBe(4);
	});

	test("the customer key is a UNION of two indexed arms, and the count agrees on a both-halves order", async () => {
		const h = makeOrderHarness(storage());
		// Linked (customerKey = the id, buyer_ref retained) + not-yet-relinked (customerKey
		// = the folded ref) + foreign. One person owns the first two.
		await seed(h, "ord-linked", { customerId: "cust-1", buyerRef: "Bob@Example.com" });
		await seed(h, "ord-guest", { customerId: null, buyerRef: "bob@example.com" });
		await seed(h, "ord-foreign", { customerId: "cust-2", buyerRef: "carol@example.com" });
		const key = { customerId: "cust-1", buyerRef: "bob@example.com" };
		const { orders: rows } = await h.store.listOrders({ customer: key }, { limit: 25 });
		expect(rows.map((o) => o.id).toSorted()).toEqual(["ord-guest", "ord-linked"]);
		// `ord-linked` satisfies BOTH arms — one row in the page, and counted ONCE by the
		// inclusion–exclusion the two arms force (|C1| + |C2| − |C1 ∧ C2|).
		expect(await h.store.countOrders({ customer: key })).toBe(2);
		// The document shape behind it: two indexed fields, not one.
		const linked = await orders().get("ord-linked");
		expect(linked?.customerKey).toBe("cust-1");
		expect(linked?.buyerRefLower).toBe("bob@example.com");
	});

	test("linkGuestOrders rewrites customerKey, so the customer filter keeps finding the order", async () => {
		const h = makeOrderHarness(storage());
		await lined(h.store, { id: "ord-guest", skus: ["SKU-G"], buyerRef: "Alice@Example.com" });
		const before = await orders().get("ord-guest");
		expect(before?.customerKey).toBe("alice@example.com"); // the folded ref, pre-link

		const cust = brandCustomerId("cust-alice");
		expect(await h.store.linkGuestOrders(cust, "alice@example.com")).toBe(1);
		const after = await orders().get("ord-guest");
		// THE R3 REWRITE. Without it the key would still hold the folded reference and a
		// `customerId`-only filter would never find the order it had just claimed.
		expect(after?.customerKey).toBe("cust-alice");
		expect(after?.customerId).toBe("cust-alice");
		expect(after?.buyerRefLower).toBe("alice@example.com"); // frozen, never rewritten
		const byId = await h.store.listOrders(
			{ customer: { customerId: "cust-alice" } },
			{ limit: 25 },
		);
		expect(byId.orders.map((o) => o.id)).toEqual(["ord-guest"]);
		// Idempotent: a second login links nothing new, and the count is unchanged.
		expect(await h.store.linkGuestOrders(cust, "alice@example.com")).toBe(0);
		expect(await h.store.countOrders({ customer: { customerId: "cust-alice" } })).toBe(1);
	});

	test("a missing by-sku index document is rebuilt by the replay, exactly once", async () => {
		const h = makeOrderHarness(storage());
		await lined(h.store, { id: "ord-heal", skus: ["SKU-HEAL", "SKU-HEAL"] });
		const id = orderSkuIndexId("sku-heal", "ord-heal");
		expect(await skuIndex().delete(id)).toBe(true);
		// With the derived document gone the sku arm cannot reach the order — the index IS
		// the arm, so this is what a torn create looks like from the list's side.
		expect((await h.store.listOrders({ search: "SKU-HEAL" }, { limit: 25 })).orders).toEqual([]);

		// A replay of the same key re-runs the derived write. Create-if-absent per pair,
		// so the two identical lines still owe exactly one document.
		await lined(h.store, { id: "ord-heal", skus: ["SKU-HEAL", "SKU-HEAL"] });
		expect(await skuIndex().get(id)).toEqual({
			sku: "sku-heal",
			orderId: "ord-heal",
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		expect((await skuIndex().query({ where: { sku: "sku-heal" }, limit: 100 })).items).toHaveLength(
			1,
		);
		const page = await h.store.listOrders({ search: "sku-heal" }, { limit: 25 });
		expect(page.orders.map((o) => o.id)).toEqual(["ord-heal"]);
		expect(await h.store.countOrders({ search: "sku-heal" })).toBe(1);
	});

	test("the outbox locator finds an entry by id, and a settle on a drained entry is a no-op", async () => {
		const h = makeOrderHarness(storage(), { countingIds: true });
		await lined(h.store, { id: "ord-mail", skus: ["SKU-M"] });
		expect(await h.store.markPaid(orderId("ord-mail"))).toBe(true);
		const claimed = await h.store.claimNextEmail(
			"2026-07-10T00:00:00.000Z",
			"2026-07-10T00:05:00.000Z",
		);
		if (claimed === null) throw new Error("the paid flip must have enqueued a claimable entry");

		// THE LOCATOR. Written by the same flip that enqueued the entry, keyed by the
		// ENTRY id — which is the only handle the dispatcher's settle half carries.
		expect(await outboxKeys().get(claimed.id)).toEqual({ orderId: "ord-mail" });

		await h.store.markEmailSent(claimed.id, "2026-07-10T00:00:01.000Z");
		const sent = await orders().get("ord-mail");
		const entry = (sent?.emailOutbox ?? []).find((row) => row.id === claimed.id);
		expect(entry?.status).toBe("sent");
		expect(sent?.emailDueAt).toBeNull(); // terminal ⇒ out of the due index entirely

		// A second settle — and a reschedule of the same drained entry — is a guarded
		// no-op, not a resurrection: only a CLAIMED entry is settleable.
		await h.store.markEmailSent(claimed.id, "2026-07-10T00:09:00.000Z");
		await h.store.rescheduleEmail(claimed.id, "2026-07-10T00:10:00.000Z");
		const after = await orders().get("ord-mail");
		const unchanged = (after?.emailOutbox ?? []).find((row) => row.id === claimed.id);
		expect(unchanged?.status).toBe("sent");
		expect(unchanged?.sentAt).toBe("2026-07-10T00:00:01.000Z");
		expect(after?.emailDueAt).toBeNull();
		// An id NOTHING ever minted is loud, not a quiet return: no locator names it and the
		// bounded walk does not hold it, and those two facts cannot distinguish "never
		// existed" from "a claimed entry whose locator was lost and whose row the walk
		// missed". The second leaves a live lease to lapse into a double send, so the
		// unresolvable case raises rather than settling silently.
		await expect(
			h.store.markEmailSent("no-such-entry", "2026-07-10T00:11:00.000Z"),
		).rejects.toThrow(/could not be located/);
	});

	test("a settle whose locator AND whose order are gone raises instead of leaving the lease", async () => {
		const h = makeOrderHarness(storage(), { countingIds: true });
		await lined(h.store, { id: "ord-lost", skus: ["SKU-L"] });
		expect(await h.store.markPaid(orderId("ord-lost"))).toBe(true);
		const claimed = await h.store.claimNextEmail(
			"2026-07-10T00:00:00.000Z",
			"2026-07-10T00:05:00.000Z",
		);
		if (claimed === null) throw new Error("the paid flip must have enqueued a claimable entry");

		// The shape the review named: the locator is gone AND the walk cannot find the row,
		// so the settle has no order to guard against. The entry is still `sending`, which is
		// exactly why a silent return would be the dangerous outcome — its lease would lapse
		// and the message would be claimed and sent a second time.
		expect(await outboxKeys().delete(claimed.id)).toBe(true);
		expect(await orders().delete("ord-lost")).toBe(true);
		await expect(
			h.store.markEmailSent(claimed.id, "2026-07-10T00:00:01.000Z"),
		).rejects.toMatchObject({ code: "OUTBOX_ENTRY_UNLOCATABLE", retryable: true });
		// `rescheduleEmail` is the same path and is equally loud — the dispatcher's failure
		// branch must not swallow a lost entry either.
		await expect(
			h.store.rescheduleEmail(claimed.id, "2026-07-10T00:10:00.000Z"),
		).rejects.toMatchObject({ code: "OUTBOX_ENTRY_UNLOCATABLE" });
	});
}
