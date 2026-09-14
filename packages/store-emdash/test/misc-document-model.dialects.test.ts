/**
 * The document shapes these four stores produce, and the one security invariant the
 * ports cannot express.
 *
 * Everything here asserts something the contract suites cannot see: which document
 * an id lands under, what a pointer names, and what happens when a delivery gate is
 * asked to authorize with no scope at all.
 */
import { idempotencyKey, orderId, productId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	entitlementLookupId,
	isEntitlementScopeRequiredError,
	isScanPageLimitError,
	SETTINGS_DOC_ID,
} from "../src/index.js";
import { countingCollection, withCollection } from "./helpers/fault-injection.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import { makeMiscHarness } from "./misc-harness.js";

const SKU = sku("DIG-1");

describeEachDialect("misc document model", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT);
	const harness = () => makeMiscHarness(bound.storage);

	// -- entitlements ----------------------------------------------------------

	test("a scopeless delivery check is refused with a typed error, and authorizes nothing", async () => {
		const h = harness();
		await h.entitlementStore.grant({
			orderId: orderId("ord-1"),
			productId: null,
			sku: SKU,
			buyerRef: "buyer@example.com",
			source: "order_paid",
			grantIdempotencyKey: idempotencyKey("g1"),
		});
		// The port's type makes both scopes optional, so this is reachable from any
		// caller that lost its session and its order id. It must refuse, not answer
		// "any active grant for this sku".
		const failure = await h.entitlementStore.check({ sku: SKU }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(isEntitlementScopeRequiredError(failure), String(failure)).toBe(true);
	});

	test("the grant document id is the grant key; the entitlement id is a field", async () => {
		const h = harness();
		const granted = await h.entitlementStore.grant({
			orderId: orderId("ord-1"),
			productId: productId("p1"),
			sku: SKU,
			buyerRef: "Buyer@Example.com",
			source: "order_paid",
			grantIdempotencyKey: idempotencyKey("grant-key-1"),
		});
		const doc = await h.grants.get("grant-key-1");
		expect(doc).not.toBeNull();
		expect(doc?.entitlementId).toBe(granted.id);
		expect(granted.id).not.toBe("grant-key-1");
		// The fold is stored alongside the reference as given, because the reference is
		// returned to the caller and the fold is the indexed axis.
		expect(doc?.buyerRef).toBe("Buyer@Example.com");
		expect(doc?.buyerRefLower).toBe("buyer@example.com");
		expect(doc?.state).toBe("active");
	});

	test("a grant points both of its scopes at its own grant key", async () => {
		const h = harness();
		await h.entitlementStore.grant({
			orderId: orderId("ord-1"),
			productId: null,
			sku: SKU,
			buyerRef: "Buyer@Example.com",
			source: "x402",
			grantIdempotencyKey: idempotencyKey("grant-key-2"),
		});
		expect(await h.lookups.count()).toBe(2);
		expect((await h.lookups.get(entitlementLookupId("order", "ord-1", "DIG-1")))?.grantKey).toBe(
			"grant-key-2",
		);
		expect(
			(await h.lookups.get(entitlementLookupId("buyer", "buyer@example.com", "DIG-1")))?.grantKey,
		).toBe("grant-key-2");
	});

	test("a scope id escapes its parts, so two different pairs can never share a pointer", async () => {
		// `("ord-a", "B:C")` and `("ord-a:B", "C")` would collide under a raw join, and
		// one document authorizing the other's delivery is a security bug rather than a
		// collision statistic.
		expect(entitlementLookupId("order", "ord-a", "B:C")).not.toBe(
			entitlementLookupId("order", "ord-a:B", "C"),
		);
		const h = harness();
		await h.entitlementStore.grant({
			orderId: orderId("ord-a"),
			productId: null,
			sku: sku("B:C"),
			buyerRef: "buyer@example.com",
			source: "order_paid",
			grantIdempotencyKey: idempotencyKey("grant-colliding"),
		});
		expect(await h.entitlementStore.check({ orderId: orderId("ord-a"), sku: sku("B:C") })).toBe(
			true,
		);
		expect(await h.entitlementStore.check({ orderId: orderId("ord-a:B"), sku: sku("C") })).toBe(
			false,
		);
	});

	test("a pointer left on a revoked grant authorizes nothing, and is re-pointed at an active one", async () => {
		const h = harness();
		const buyer = "buyer@example.com";
		for (const [key, order] of [
			["g-ord1", "ord-1"],
			["g-ord2", "ord-2"],
		] as const) {
			await h.entitlementStore.grant({
				orderId: orderId(order),
				productId: null,
				sku: SKU,
				buyerRef: buyer,
				source: "order_paid",
				grantIdempotencyKey: idempotencyKey(key),
			});
		}
		// Two grants for one buyer scope, ONE pointer — the first committer keeps it.
		const scopeId = entitlementLookupId("buyer", buyer, "DIG-1");
		expect((await h.lookups.get(scopeId))?.grantKey).toBe("g-ord1");

		await h.revoke("ord-1");
		// The pointer still names the revoked grant, so the answer has to come from the
		// index — and it does, because the pointer is a cache and not authority.
		expect(await h.entitlementStore.check({ buyerRef: buyer, sku: SKU })).toBe(true);
		expect((await h.lookups.get(scopeId))?.grantKey).toBe("g-ord2");
		// The revoked grant's OWN order scope is refused: nothing else covers it.
		expect(await h.entitlementStore.check({ orderId: orderId("ord-1"), sku: SKU })).toBe(false);
	});

	// -- order notes -----------------------------------------------------------

	test("the note document id is the idempotency key, and the note id is a field", async () => {
		const h = harness();
		const { note } = await h.orderNotesStore.append({
			orderId: orderId("ord-1"),
			author: "alice",
			body: "gift-wrap",
			idempotencyKey: idempotencyKey("note-key-1"),
		});
		const doc = await h.notes.get("note-key-1");
		expect(doc).not.toBeNull();
		expect(doc?.noteId).toBe(note.id);
		expect(note.id).not.toBe("note-key-1");
		expect(doc?.orderId).toBe("ord-1");
	});

	test("one idempotency key is once-only ACROSS orders, as the table-wide UNIQUE was", async () => {
		const h = harness();
		const first = await h.orderNotesStore.append({
			orderId: orderId("ord-1"),
			author: "alice",
			body: "for ord-1",
			idempotencyKey: idempotencyKey("shared-key"),
		});
		const second = await h.orderNotesStore.append({
			orderId: orderId("ord-2"),
			author: "bob",
			body: "for ord-2",
			idempotencyKey: idempotencyKey("shared-key"),
		});
		expect(second.appended).toBe(false);
		expect(second.note).toEqual(first.note);
		expect(await h.notes.count()).toBe(1);
		expect(await h.orderNotesStore.listForOrder(orderId("ord-2"))).toEqual([]);
	});

	test("listing an order's notes is one paged read, not one read per note", async () => {
		// `order_notes` is a child collection precisely so support volume cannot enlarge
		// the document the money path compare-and-sets — but a child collection is only
		// a win if the list does not pay a round trip per row. The tally is over a REAL
		// collection: every call is delegated, nothing is faked.
		const counted = countingCollection(bound.collection("order_notes"));
		const h = makeMiscHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, "order_notes", counted.collection),
		});
		for (const n of [1, 2, 3, 4, 5]) {
			await h.orderNotesStore.append({
				orderId: orderId("ord-1"),
				author: "alice",
				body: `note ${String(n)}`,
				idempotencyKey: idempotencyKey(`bulk-${String(n)}`),
			});
		}
		const before = counted.counts.of("query");
		const notes = await h.orderNotesStore.listForOrder(orderId("ord-1"));
		expect(notes).toHaveLength(5);
		expect(counted.counts.of("query") - before).toBe(1);
		// And no read of any other document went with it.
		expect(counted.counts.of("get")).toBe(5);
	});

	// -- settings --------------------------------------------------------------

	test("the singleton lives under one fixed id, and a mutation records intent then outcome", async () => {
		const h = harness();
		await h.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"));
		expect(await h.settings.count()).toBe(1);
		expect((await h.settings.get(SETTINGS_DOC_ID))?.holdTtlMinutes).toBe(30);

		// The claim carries the PATCH as written — the fields the caller asked for, and
		// no others — plus the result it actually applied, stamped after the write.
		const first = await h.mutations.get("s1");
		expect(first?.patch).toEqual({ holdTtlMinutes: 30 });
		expect(first?.result).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 5 });
		expect(first?.appliedRevision).not.toBeNull();
		expect(first?.appliedAt).not.toBeNull();

		// A partial patch keeps the other field, and the recorded result says so.
		await h.settingsStore.update({ lowStockThreshold: 2 }, idempotencyKey("s2"));
		const second = await h.mutations.get("s2");
		expect(second?.patch).toEqual({ lowStockThreshold: 2 });
		expect(second?.result).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 2 });
	});

	test("a recorded result is single-assignment: a replay writes nothing at all", async () => {
		const h = harness();
		await h.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"));
		const recorded = await h.mutations.getVersioned("s1");
		const settingsBefore = await h.settings.getVersioned(SETTINGS_DOC_ID);

		expect(await h.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"))).toEqual(
			recorded?.value.result,
		);
		// Neither document moved — the revision is the proof, not the value.
		expect((await h.mutations.getVersioned("s1"))?.revision).toBe(recorded?.revision);
		expect((await h.settings.getVersioned(SETTINGS_DOC_ID))?.revision).toBe(
			settingsBefore?.revision,
		);
	});

	// -- order notes, paged ----------------------------------------------------

	test("an order with more notes than one page returns all of them, in append order", async () => {
		const h = harness();
		const total = 105;
		for (let i = 0; i < total; i++) {
			h.advance(1000);
			await h.orderNotesStore.append({
				orderId: orderId("ord-paged"),
				author: "alice",
				body: `note ${String(i).padStart(3, "0")}`,
				idempotencyKey: idempotencyKey(`paged-${String(i)}`),
			});
		}
		const notes = await h.orderNotesStore.listForOrder(orderId("ord-paged"));
		expect(notes).toHaveLength(total);
		// The host clamps a page at 100, so this crossed a cursor — and the ordering is
		// applied AFTER the pages are joined, which is the part a single-page list would
		// never exercise.
		expect(notes.map((n) => n.body)).toEqual(
			Array.from({ length: total }, (_unused, i) => `note ${String(i).padStart(3, "0")}`),
		);
	});

	test("a note list that exhausts its page budget refuses rather than truncating", async () => {
		const h = makeMiscHarness(bound.storage, { maxNotePages: 1 });
		for (let i = 0; i < 101; i++) {
			await h.orderNotesStore.append({
				orderId: orderId("ord-budget"),
				author: "alice",
				body: `note ${String(i)}`,
				idempotencyKey: idempotencyKey(`budget-${String(i)}`),
			});
		}
		const failure = await h.orderNotesStore.listForOrder(orderId("ord-budget")).then(
			() => undefined,
			(err: unknown) => err,
		);
		// A short note list reads as "nobody wrote that", so the ceiling is loud and it
		// names the budget to raise.
		expect(isScanPageLimitError(failure), String(failure)).toBe(true);
		if (isScanPageLimitError(failure)) {
			expect(failure.budgetOption).toBe("maxNotePages");
			expect(failure.operation).toBe("listNotesForOrder");
			expect(failure.collected).toBe(100);
		}
	});
});
