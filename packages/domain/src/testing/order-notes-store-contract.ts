import { describe, expect, test } from "vitest";
import { idempotencyKey, orderId } from "../money/ids.js";
import type { OrderNotesStore } from "../ports/order-notes-store.js";

export interface OrderNotesStoreHarness {
	store: OrderNotesStore;
	/** Advance the store's clock by `ms` so successive appends get DISTINCT
	 *  `created_at` timestamps (proves chronological ordering, not just the id
	 *  tie-break). The fake and the Kysely harness both drive a `FixedClock`. */
	tick(ms: number): void;
}

export interface OrderNotesStoreContractOptions {
	dialect: string;
}

/**
 * The reusable `OrderNotesStore` behavioral spec (admin-UX Increment 0): append a
 * note, list notes in append order, per-order scoping, and once-only idempotent
 * replay. Append-only — no edit/delete surface exists in this slice. Runs against
 * the fake first, then each DB dialect. Money-free (a note is a plain merchant
 * annotation), so there is no concurrency/no-oversell case HERE — the pg-backed
 * concurrent-replay race lives in the store-postgres dialects test.
 */
export function orderNotesStoreContract(
	makeHarness: () => Promise<OrderNotesStoreHarness>,
	opts: OrderNotesStoreContractOptions,
): void {
	describe(`orderNotesStoreContract [${opts.dialect}]`, () => {
		test("append persists author + body + a server-assigned createdAt, and lists it", async () => {
			const { store } = await makeHarness();
			const { appended, note } = await store.append({
				orderId: orderId("ord-1"),
				author: "alice@shop.example",
				body: "Customer asked to gift-wrap.",
				idempotencyKey: idempotencyKey("note-key-1"),
			});
			expect(appended).toBe(true);
			expect(note.orderId).toBe("ord-1");
			expect(note.author).toBe("alice@shop.example");
			expect(note.body).toBe("Customer asked to gift-wrap.");
			expect(typeof note.id).toBe("string");
			expect(note.id.length).toBeGreaterThan(0);
			// createdAt is a real ISO-8601 UTC timestamp assigned by the store.
			expect(note.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

			const listed = await store.listForOrder(orderId("ord-1"));
			expect(listed).toHaveLength(1);
			expect(listed[0]).toEqual(note);
		});

		test("listForOrder returns notes in append order (chronological)", async () => {
			const h = await makeHarness();
			await h.store.append({
				orderId: orderId("ord-1"),
				author: "a",
				body: "first",
				idempotencyKey: idempotencyKey("k1"),
			});
			h.tick(1000);
			await h.store.append({
				orderId: orderId("ord-1"),
				author: "b",
				body: "second",
				idempotencyKey: idempotencyKey("k2"),
			});
			h.tick(1000);
			await h.store.append({
				orderId: orderId("ord-1"),
				author: "c",
				body: "third",
				idempotencyKey: idempotencyKey("k3"),
			});
			const notes = await h.store.listForOrder(orderId("ord-1"));
			expect(notes.map((n) => n.body)).toEqual(["first", "second", "third"]);
		});

		test("notes sharing a timestamp keep a stable append order via the id tie-break", async () => {
			// No tick between appends ⇒ identical created_at; the id ASC tie-break must
			// still yield insertion order deterministically.
			const h = await makeHarness();
			for (const body of ["n1", "n2", "n3", "n4"]) {
				await h.store.append({
					orderId: orderId("ord-1"),
					author: "same-instant",
					body,
					idempotencyKey: idempotencyKey(`same-${body}`),
				});
			}
			const notes = await h.store.listForOrder(orderId("ord-1"));
			expect(notes.map((n) => n.body)).toEqual(["n1", "n2", "n3", "n4"]);
		});

		test("listForOrder is scoped to one order — another order's notes never leak in", async () => {
			const h = await makeHarness();
			await h.store.append({
				orderId: orderId("ord-A"),
				author: "a",
				body: "for A",
				idempotencyKey: idempotencyKey("a1"),
			});
			await h.store.append({
				orderId: orderId("ord-B"),
				author: "b",
				body: "for B",
				idempotencyKey: idempotencyKey("b1"),
			});
			const a = await h.store.listForOrder(orderId("ord-A"));
			const b = await h.store.listForOrder(orderId("ord-B"));
			expect(a.map((n) => n.body)).toEqual(["for A"]);
			expect(b.map((n) => n.body)).toEqual(["for B"]);
		});

		test("listForOrder on an order with no notes returns an empty list", async () => {
			const { store } = await makeHarness();
			expect(await store.listForOrder(orderId("nope"))).toEqual([]);
		});

		test("replaying the same idempotencyKey is once-only (appended:false, same note, no duplicate)", async () => {
			const { store } = await makeHarness();
			const first = await store.append({
				orderId: orderId("ord-1"),
				author: "alice",
				body: "only once",
				idempotencyKey: idempotencyKey("dup-key"),
			});
			expect(first.appended).toBe(true);

			// A replay carries the SAME key (even with a different body) — the store
			// must dedupe on the key and return the ORIGINAL note, writing nothing.
			const replay = await store.append({
				orderId: orderId("ord-1"),
				author: "alice",
				body: "a different body that must be ignored",
				idempotencyKey: idempotencyKey("dup-key"),
			});
			expect(replay.appended).toBe(false);
			expect(replay.note).toEqual(first.note);

			const notes = await store.listForOrder(orderId("ord-1"));
			expect(notes).toHaveLength(1);
			expect(notes[0]?.body).toBe("only once");
		});

		test("distinct idempotencyKeys create distinct notes", async () => {
			const { store } = await makeHarness();
			await store.append({
				orderId: orderId("ord-1"),
				author: "a",
				body: "one",
				idempotencyKey: idempotencyKey("k-one"),
			});
			await store.append({
				orderId: orderId("ord-1"),
				author: "a",
				body: "two",
				idempotencyKey: idempotencyKey("k-two"),
			});
			const notes = await store.listForOrder(orderId("ord-1"));
			expect(notes).toHaveLength(2);
			expect(new Set(notes.map((n) => n.id)).size).toBe(2);
		});
	});
}
