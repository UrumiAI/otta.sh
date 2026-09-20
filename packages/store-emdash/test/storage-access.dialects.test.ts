/**
 * The `StorageAccess` port against the REAL host repository, on every dialect.
 *
 * This is the scaffold's contract: every primitive the commerce adapters will be
 * built out of, exercised against `PluginStorageRepository` over a migrated
 * database. It is deliberately about the PORT and not about any store — if this
 * suite is green, an adapter written against `src/storage-access.ts` is running
 * on semantics that were executed, not assumed.
 *
 * The Postgres tier carries the one case SQLite cannot express: better-sqlite3
 * serializes writes in one process, so it verifies the SQL, never the race.
 */
import type { PluginContext } from "emdash";
import type { StorageAccess } from "../src/index.js";
import {
	collectionOf,
	isStorageQueryError,
	isStorageSerializationError,
	systemClock,
	uuidIdGen,
} from "../src/index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { describeEachDialect, type StorageLayout } from "./describe-each-dialect.js";

interface Counter {
	n: number;
	bucket: string;
	label?: string;
}

interface LedgerEntry {
	key: string;
	kind: string;
}

/**
 * Two collections, declared the way the plugin descriptor declares them —
 * `ledger` carries a `uniqueIndexes` entry so the composed allow-list (declared
 * indexes PLUS unique indexes) is asserted by a query rather than by a comment.
 */
const LAYOUT: StorageLayout = {
	counters: { indexes: ["n", "bucket"] },
	ledger: { indexes: ["kind"], uniqueIndexes: ["key"] },
};

/**
 * The production half of the seam, pinned at compile time: what the host hands a
 * plugin as `ctx.storage` must satisfy Otta's port, or the adapters typecheck
 * against a shape production never supplies. Nothing here runs — the assertion
 * IS the test, and it fails at `pnpm typecheck`.
 */
it("accepts the host's own ctx.storage as a StorageAccess", () => {
	expectTypeOf<PluginContext["storage"]>().toExtend<StorageAccess>();
});

describe("the in-process id and clock adapters", () => {
	// `uuidIdGen` duplicated `@otta-sh/store-postgres`'s function deliberately:
	// `store-emdash-is-sandbox-clean` forbids importing that package, because it
	// would drag a Kysely/pg graph into a module that is bundled into workerd. The
	// store-postgres package is gone; this is the surviving copy.
	it("draws distinct v4 UUIDs", () => {
		const drawn = new Set<string>();
		for (let i = 0; i < 1000; i++) drawn.add(uuidIdGen.newId());
		expect(drawn.size).toBe(1000);
		for (const id of drawn) {
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		}
	});

	it("reads real time as a Date", () => {
		const before = Date.now();
		const now = systemClock.now();
		const after = Date.now();
		expect(now).toBeInstanceOf(Date);
		expect(now.getTime()).toBeGreaterThanOrEqual(before);
		expect(now.getTime()).toBeLessThanOrEqual(after);
	});
});

describeEachDialect("the StorageAccess port over a real PluginStorageRepository", (ctx) => {
	const db = ctx.useStorage(LAYOUT);
	const counters = () => db.collection<Counter>("counters");
	const ledger = () => db.collection<LedgerEntry>("ledger");

	it("refuses a collection the descriptor never declared", () => {
		// The narrowing's own failure mode, and the one worth a test: `ctx.storage`
		// holds only what the descriptor declared, and the descriptor is edited in a
		// different file from the adapter. This is what a mismatch looks like — an
		// error naming the collection, not `undefined.get is not a function` several
		// frames into a use-case.
		expect(() => collectionOf(db.storage, "nope")).toThrow(/'nope' is not declared/);
		expect(() => collectionOf(db.storage, "nope")).toThrow(/plugin descriptor/);
	});

	it("round-trips a document through put and get", async () => {
		await counters().put("c1", { n: 3, bucket: "a", label: "first" });
		expect(await counters().get("c1")).toEqual({ n: 3, bucket: "a", label: "first" });
		expect(await counters().get("missing")).toBeNull();
	});

	it("queries a declared index with where, orderBy and limit", async () => {
		await counters().put("c1", { n: 1, bucket: "a" });
		await counters().put("c2", { n: 2, bucket: "a" });
		await counters().put("c3", { n: 3, bucket: "b" });

		const page = await counters().query({
			where: { bucket: "a" },
			orderBy: { n: "desc" },
			limit: 10,
		});
		expect(page.items.map((item) => item.id)).toEqual(["c2", "c1"]);
		expect(page.hasMore).toBe(false);

		const capped = await counters().query({
			where: { bucket: "a" },
			orderBy: { n: "asc" },
			limit: 1,
		});
		expect(capped.items.map((item) => item.id)).toEqual(["c1"]);
		expect(capped.hasMore).toBe(true);
	});

	it("queries a field declared only as a unique index", async () => {
		// The repository is constructed with indexes AND uniqueIndexes composed
		// into one allow-list, exactly as the host composes them — so `key` is
		// queryable even though it appears only under `uniqueIndexes`. What the
		// harness does NOT create is a physical unique index: uniqueness is not
		// enforced here, and no adapter may rely on it being.
		await ledger().put("l1", { key: "k-1", kind: "hold" });
		await ledger().put("l2", { key: "k-2", kind: "hold" });

		const page = await ledger().query({ where: { key: "k-2" } });
		expect(page.items.map((item) => item.id)).toEqual(["l2"]);
		expect(await ledger().count({ kind: "hold" })).toBe(2);
	});

	it("counts matching documents", async () => {
		await counters().put("c1", { n: 1, bucket: "a" });
		await counters().put("c2", { n: 2, bucket: "a" });
		await counters().put("c3", { n: 3, bucket: "b" });

		expect(await counters().count()).toBe(3);
		expect(await counters().count({ bucket: "a" })).toBe(2);
		expect(await counters().count({ n: { gte: 2 } })).toBe(2);
	});

	it("deletes a document, and reports whether there was one", async () => {
		await counters().put("c1", { n: 1, bucket: "a" });
		expect(await counters().delete("c1")).toBe(true);
		expect(await counters().get("c1")).toBeNull();
		expect(await counters().delete("c1")).toBe(false);
	});

	it("applies a guarded decrement exactly as far as the guard allows", async () => {
		await counters().put("stock", { n: 1, bucket: "a" });

		const first = await counters().updateIf("stock", {
			where: { n: { gte: 1 } },
			delta: { n: { dec: 1 } },
		});
		expect(first.applied).toBe(true);
		if (first.applied) expect(first.data.n).toBe(0);

		const second = await counters().updateIf("stock", {
			where: { n: { gte: 1 } },
			delta: { n: { dec: 1 } },
		});
		expect(second.applied).toBe(false);
		expect((await counters().get("stock"))?.n).toBe(0);
	});

	it("never inserts: a guarded update on an absent row does not apply", async () => {
		const result = await counters().updateIf("absent", {
			where: {},
			set: { bucket: "a" },
		});
		expect(result.applied).toBe(false);
		expect(await counters().get("absent")).toBeNull();
	});

	it("reads a document with its opaque revision", async () => {
		await counters().put("c1", { n: 7, bucket: "a" });

		const versioned = await counters().getVersioned("c1");
		expect(versioned?.value).toEqual({ n: 7, bucket: "a" });
		expect(typeof versioned?.revision).toBe("string");
		expect(versioned?.revision).not.toBe("");
		expect(await counters().getVersioned("missing")).toBeNull();
	});

	it("creates only when absent, on a null expected revision", async () => {
		const created = await counters().compareAndSet("c1", null, { n: 1, bucket: "a" });
		expect(created.applied).toBe(true);

		const again = await counters().compareAndSet("c1", null, { n: 99, bucket: "z" });
		expect(again.applied).toBe(false);
		expect(await counters().get("c1")).toEqual({ n: 1, bucket: "a" });
	});

	it("swaps on the current revision and refuses a stale one", async () => {
		await counters().put("c1", { n: 1, bucket: "a" });
		const first = await counters().getVersioned("c1");
		const stale = first?.revision ?? "";

		const applied = await counters().compareAndSet("c1", stale, { n: 2, bucket: "a" });
		expect(applied.applied).toBe(true);
		if (!applied.applied) throw new Error("unreachable");
		expect(applied.revision).not.toBe(stale);

		const refused = await counters().compareAndSet("c1", stale, { n: 3, bucket: "a" });
		expect(refused.applied).toBe(false);
		expect(await counters().get("c1")).toEqual({ n: 2, bucket: "a" });
	});

	it("deletes only on the current revision", async () => {
		await counters().put("c1", { n: 1, bucket: "a" });
		const stale = (await counters().getVersioned("c1"))?.revision ?? "";
		const swapped = await counters().compareAndSet("c1", stale, { n: 2, bucket: "a" });
		if (!swapped.applied) throw new Error("unreachable");

		expect((await counters().compareAndDelete("c1", stale)).applied).toBe(false);
		expect(await counters().get("c1")).not.toBeNull();

		expect((await counters().compareAndDelete("c1", swapped.revision)).applied).toBe(true);
		expect(await counters().get("c1")).toBeNull();
	});

	it("refuses a query on a field the collection never declared", async () => {
		await counters().put("c1", { n: 1, bucket: "a", label: "x" });

		const err = await counters()
			.query({ where: { label: "x" } })
			.catch((e: unknown) => e);
		expect(isStorageQueryError(err)).toBe(true);
		// The FIELD is the contract, not the host's wording.
		expect(isStorageQueryError(err) && err.field).toBe("label");

		const ordered = await counters()
			.query({ orderBy: { label: "asc" } })
			.catch((e: unknown) => e);
		expect(isStorageQueryError(ordered) && ordered.field).toBe("label");
	});

	it("clamps a page to the host's ceiling of 100, and pages past it", async () => {
		for (let i = 0; i < 105; i++) {
			await counters().put(`c${String(i).padStart(3, "0")}`, { n: i, bucket: "a" });
		}

		const page = await counters().query({
			where: { bucket: "a" },
			orderBy: { n: "asc" },
			limit: 500,
		});
		expect(page.items).toHaveLength(100);
		expect(page.hasMore).toBe(true);
		expect(page.cursor).toBeDefined();

		const rest = await counters().query({
			where: { bucket: "a" },
			orderBy: { n: "asc" },
			limit: 500,
			cursor: page.cursor,
		});
		expect(rest.items).toHaveLength(5);
		expect(rest.hasMore).toBe(false);
		expect(rest.items.map((item) => item.data.n)).toEqual([100, 101, 102, 103, 104]);
	});

	it.runIf(ctx.canRace)(
		"lets exactly one of ten concurrent compare-and-sets on one revision win",
		async () => {
			await counters().put("stock", { n: 0, bucket: "a" });
			const revision = (await counters().getVersioned("stock"))?.revision ?? "";

			const settled = await Promise.allSettled(
				Array.from({ length: 10 }, (_unused, i) =>
					counters().compareAndSet("stock", revision, { n: i + 1, bucket: "a" }),
				),
			);

			const winners = settled.flatMap((outcome, i) =>
				outcome.status === "fulfilled" && outcome.value.applied ? [i + 1] : [],
			);
			expect(winners).toHaveLength(1);

			// A loser must never apply. It either says `applied: false` — the
			// READ COMMITTED path — or it aborts RETRYABLY, and nothing else is an
			// acceptable way to lose: an unrelated failure would otherwise let this
			// case pass while nine attempts died for nine unrelated reasons.
			for (const outcome of settled) {
				if (outcome.status === "rejected") {
					expect(isStorageSerializationError(outcome.reason)).toBe(true);
				} else {
					expect(typeof outcome.value.applied).toBe("boolean");
				}
			}

			// And the surviving document is the winner's, not a mix of ten writes.
			expect(await counters().get("stock")).toEqual({ n: winners[0], bucket: "a" });
		},
		30_000,
	);
});
