import { appendOrderNote, idempotencyKey, listOrderNotes, orderId } from "@urumi/domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryOrderNotesStore,
	InMemoryOrderStore,
} from "@urumi/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";

// The appendOrderNote use-case (admin-UX Increment 0): validation (non-empty
// author/body, order-must-exist), trimming, and delegation to the store's
// once-only append. Pure orchestration over two in-memory fakes.

const ORDER = orderId("ord-1");

function build() {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	const orderNotesStore = new InMemoryOrderNotesStore({
		idGen: new CountingIdGen("note"),
		clock,
	});
	// Seed a bare order the notes hang off (the use-case rejects notes on a
	// non-existent order).
	orderStore.seedSummaryOrder({
		id: "ord-1",
		state: "paid",
		currency: "USD",
		buyerRef: "buyer@example.com",
		createdAt: "2026-07-10T00:00:00.000Z",
		totalCents: 1000,
	});
	return { deps: { orderNotesStore, orderStore }, clock };
}

describe("appendOrderNote", () => {
	let ctx: ReturnType<typeof build>;
	beforeEach(() => {
		ctx = build();
	});

	test("appends a note to an existing order and lists it back", async () => {
		const res = await appendOrderNote(ctx.deps, {
			orderId: ORDER,
			author: "alice",
			body: "packed and ready",
			idempotencyKey: idempotencyKey("k1"),
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.appended).toBe(true);
		expect(res.note.author).toBe("alice");
		const notes = await listOrderNotes(ctx.deps, ORDER);
		expect(notes.map((n) => n.body)).toEqual(["packed and ready"]);
	});

	test("trims author + body and persists the trimmed values", async () => {
		const res = await appendOrderNote(ctx.deps, {
			orderId: ORDER,
			author: "  bob  ",
			body: "  needs a call back  ",
			idempotencyKey: idempotencyKey("k1"),
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.note.author).toBe("bob");
		expect(res.note.body).toBe("needs a call back");
	});

	test("rejects an empty (or whitespace-only) body", async () => {
		const res = await appendOrderNote(ctx.deps, {
			orderId: ORDER,
			author: "alice",
			body: "   ",
			idempotencyKey: idempotencyKey("k1"),
		});
		expect(res).toEqual({ ok: false, reason: "EMPTY_BODY" });
		expect(await listOrderNotes(ctx.deps, ORDER)).toEqual([]);
	});

	test("rejects an empty author", async () => {
		const res = await appendOrderNote(ctx.deps, {
			orderId: ORDER,
			author: "",
			body: "hello",
			idempotencyKey: idempotencyKey("k1"),
		});
		expect(res).toEqual({ ok: false, reason: "EMPTY_AUTHOR" });
	});

	test("rejects a note on a non-existent order", async () => {
		const res = await appendOrderNote(ctx.deps, {
			orderId: orderId("ghost"),
			author: "alice",
			body: "hello",
			idempotencyKey: idempotencyKey("k1"),
		});
		expect(res).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
	});

	test("replaying the same idempotencyKey appends once (appended:false on replay)", async () => {
		const cmd = {
			orderId: ORDER,
			author: "alice",
			body: "only once",
			idempotencyKey: idempotencyKey("dup"),
		};
		const first = await appendOrderNote(ctx.deps, cmd);
		const replay = await appendOrderNote(ctx.deps, cmd);
		expect(first.ok && first.appended).toBe(true);
		expect(replay.ok && replay.appended).toBe(false);
		expect(await listOrderNotes(ctx.deps, ORDER)).toHaveLength(1);
	});
});
