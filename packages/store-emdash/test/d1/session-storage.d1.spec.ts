/**
 * The storage paths run through a real D1 **session** handle — the handle EmDash
 * gives the plugin per request under `session: "primary-first"`. See
 * `describe-d1-session.ts` for how the handle is built and for what miniflare can
 * and cannot show: it has no replicas, so this file proves the code paths work over
 * a session, not that a replica read is never stale. Staging still has to show that
 * before read replication is switched on (#490).
 */
import { DuplicateCustomerEmailError, email, idempotencyKey } from "@urumi.ai/otta-domain";
import { CountingIdGen, FixedClock } from "@urumi.ai/otta-domain/testing";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
	CLAIM_ABANDON_AFTER_MS,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	newInventoryDoc,
	type InventoryDoc,
} from "../../src/index.js";
import { IDENTITY_LAYOUT } from "../identity-collections.js";
import { makeIdentityHarness, type IdentityHarness } from "../identity-harness.js";
import { INVENTORY_LAYOUT } from "../inventory-collections.js";
import { useD1SessionStorage } from "./describe-d1-session.js";
import type { StorageLayout } from "./describe-d1.js";

/** `notes` is the scratch collection; the rest are the stores' own layouts. */
const LAYOUT: StorageLayout = { notes: { indexes: [] }, ...IDENTITY_LAYOUT, ...INVENTORY_LAYOUT };

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

	it("refuses a write at a revision another session has since replaced", async () => {
		const a = sessions.request({ isWrite: true }).collection<Note>("notes");
		const b = sessions.request({ isWrite: true }).collection<Note>("notes");
		const created = await a.compareAndSet("a", null, { text: "v1" });
		if (!created.applied) throw new Error("create-if-absent must apply on an empty row");

		// A holds the revision; B, on its own session, moves the row on. Correctness
		// must not depend on how fresh A's read was.
		const held = await a.getVersioned("a");
		expect((await b.compareAndSet("a", created.revision, { text: "by-b" })).applied).toBe(true);

		const refused = await a.compareAndSet("a", held?.revision ?? null, { text: "by-a" });
		expect(refused.applied).toBe(false);
		expect(await b.get("a")).toEqual({ text: "by-b" });
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

describe("claims and leases over sessions", () => {
	const ORPHAN = "orphan@example.com";

	/** A claim no account holds, stamped by `h`'s clock: a registrant mid-flight. */
	async function leaveLiveClaim(h: IdentityHarness): Promise<void> {
		await h.emailClaims.put(ORPHAN, {
			emailLower: ORPHAN,
			customerId: "cust-crashed",
			claimedAt: h.now(),
		});
	}

	it("refuses a second registrant while the first holds the address, on another session", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const first = makeIdentityHarness(sessions.request({ isWrite: true }).storage, { clock });
		const second = makeIdentityHarness(sessions.request({ isWrite: true }).storage, {
			clock,
			idPrefix: "b-",
		});

		const registered = await first.customerStore.create({ email: email("held@example.com") });
		await expect(
			second.customerStore.create({ email: email("held@example.com") }),
		).rejects.toBeInstanceOf(DuplicateCustomerEmailError);
		expect((await second.customerStore.getByEmail(email("held@example.com")))?.id).toBe(
			registered.id,
		);
	});

	it("refuses a claimant while the holder's claim is inside its lease", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const holder = makeIdentityHarness(sessions.request({ isWrite: true }).storage, { clock });
		const claimant = makeIdentityHarness(sessions.request({ isWrite: true }).storage, {
			clock,
			idPrefix: "b-",
		});
		await leaveLiveClaim(holder);

		holder.advance(CLAIM_ABANDON_AFTER_MS - 1);
		await expect(claimant.customerStore.create({ email: email(ORPHAN) })).rejects.toBeInstanceOf(
			DuplicateCustomerEmailError,
		);
		expect((await claimant.emailClaims.get(ORPHAN))?.customerId).toBe("cust-crashed");
	});

	it("lets a claimant take the claim over once the lease has lapsed", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const holder = makeIdentityHarness(sessions.request({ isWrite: true }).storage, { clock });
		const claimant = makeIdentityHarness(sessions.request({ isWrite: true }).storage, {
			clock,
			idPrefix: "b-",
		});
		await leaveLiveClaim(holder);

		holder.advance(CLAIM_ABANDON_AFTER_MS);
		const registered = await claimant.customerStore.create({ email: email(ORPHAN) });
		expect((await claimant.emailClaims.get(ORPHAN))?.customerId).toBe(registered.id);
	});
});

describe("read-after-write over sessions", () => {
	it("sees its own write on the same session, with no commit in between", async () => {
		const notes = sessions.request({ isWrite: true }).collection<Note>("notes");
		await notes.put("a", { text: "v1" });
		expect(await notes.get("a")).toEqual({ text: "v1" });
		await notes.put("a", { text: "v2" });
		expect(await notes.get("a")).toEqual({ text: "v2" });
		expect((await notes.getVersioned("a"))?.value).toEqual({ text: "v2" });
	});

	it("sees a store's write on the same session: the account is found by address", async () => {
		const h = makeIdentityHarness(sessions.request({ isWrite: true }).storage);
		const registered = await h.customerStore.create({ email: email("raw@example.com") });
		expect((await h.customerStore.getByEmail(email("raw@example.com")))?.id).toBe(registered.id);
		expect((await h.customers.get(registered.id))?.email).toBe("raw@example.com");
	});

	it("sees a write committed by an earlier request when it presents that request's bookmark", async () => {
		// Spy on the binding the host opens sessions on, so the case pins WHICH
		// constraint each request started with, not only that the read worked.
		const spy = vi.spyOn(env.DB as { withSession(constraint: string): unknown }, "withSession");
		try {
			const writing = sessions.request({ isWrite: true });
			await writing.collection<Note>("notes").put("a", { text: "written" });
			const bookmark = writing.commit();
			if (bookmark === undefined) throw new Error("an authenticated write must mint a bookmark");

			const reading = sessions.request({ isWrite: false, bookmark });
			expect(await reading.collection<Note>("notes").get("a")).toEqual({ text: "written" });

			// A write starts on the primary; the reader resumes from the writer's bookmark.
			expect(spy.mock.calls.map(([constraint]) => constraint)).toEqual(["first-primary", bookmark]);
		} finally {
			spy.mockRestore();
		}
	});
});
