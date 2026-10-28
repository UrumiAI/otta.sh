/**
 * The storage paths run through a real D1 **session** handle — the handle EmDash
 * gives the plugin per request under `session: "primary-first"`. See
 * `describe-d1-session.ts` for how the handle is built and for what miniflare can
 * and cannot show: it has no replicas, so this file proves the code paths work over
 * a session, not that a replica read is never stale. Staging still has to show that
 * before read replication is switched on (#490).
 */
import { idempotencyKey } from "@urumi.ai/otta-domain";
import { CountingIdGen, FixedClock } from "@urumi.ai/otta-domain/testing";
import { describe, expect, it } from "vitest";
import {
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	newInventoryDoc,
	type InventoryDoc,
} from "../../src/index.js";
import { INVENTORY_LAYOUT } from "../inventory-collections.js";
import { BOOKMARK_COOKIE, useD1SessionStorage } from "./describe-d1-session.js";
import type { StorageLayout } from "./describe-d1.js";

/** `notes` is the scratch collection; the rest are the stores' own layouts. */
const LAYOUT: StorageLayout = { notes: { indexes: [] }, ...INVENTORY_LAYOUT };

interface Note {
	text: string;
}

const sessions = useD1SessionStorage(LAYOUT);

describe("the session harness", () => {
	it("runs the statements through a session: the commit stores a bookmark", async () => {
		const request = sessions.request({ isWrite: true });
		await request.collection<Note>("notes").put("a", { text: "hello" });
		const bookmark = request.commit();
		expect(bookmark).toBeTypeOf("string");
		expect(bookmark?.length).toBeGreaterThan(0);
	});

	it("reads a document back through the same session", async () => {
		const request = sessions.request({ isWrite: true });
		await request.collection<Note>("notes").put("a", { text: "hello" });
		expect(await request.collection<Note>("notes").get("a")).toEqual({ text: "hello" });
		expect(BOOKMARK_COOKIE).toBe("__em_d1_bookmark");
	});
});

describe("compare-and-set over one session", () => {
	it("refuses a write at a stale revision and keeps the winner's document", async () => {
		const notes = sessions.request({ isWrite: true }).collection<Note>("notes");
		const created = await notes.compareAndSet("a", null, { text: "v1" });
		if (!created.applied) throw new Error("create-if-absent must apply on an empty row");

		const winner = await notes.compareAndSet("a", created.revision, { text: "v2" });
		expect(winner.applied).toBe(true);

		// The caller still holds the revision the winner replaced.
		const stale = await notes.compareAndSet("a", created.revision, { text: "stale" });
		expect(stale.applied).toBe(false);
		expect(await notes.get("a")).toEqual({ text: "v2" });
	});

	it("refuses create-if-absent when the row already exists", async () => {
		const notes = sessions.request({ isWrite: true }).collection<Note>("notes");
		expect((await notes.compareAndSet("a", null, { text: "first" })).applied).toBe(true);
		expect((await notes.compareAndSet("a", null, { text: "second" })).applied).toBe(false);
		expect(await notes.get("a")).toEqual({ text: "first" });
	});

	it("serves a store's guarded write: the second reserve of the last unit is refused", async () => {
		const request = sessions.request({ isWrite: true });
		const inventory = request.collection<InventoryDoc>(INVENTORY_COLLECTION);
		await inventory.compareAndSet("sku-1", null, newInventoryDoc("sku-1", 1));
		const store = new EmdashInventoryStore({
			storage: request.storage,
			idGen: new CountingIdGen("res"),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		});

		const first = await store.reserve("sku-1", 1, idempotencyKey("k1"));
		const second = await store.reserve("sku-1", 1, idempotencyKey("k2"));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		const doc = await inventory.get("sku-1");
		expect(doc?.onHand).toBe(0);
		expect(Object.keys(doc?.holds ?? {})).toEqual(["k1"]);
	});
});
