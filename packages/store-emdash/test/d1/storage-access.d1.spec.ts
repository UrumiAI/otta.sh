/**
 * The `StorageAccess` port against the REAL host repository, on **D1**.
 *
 * This is the primitive half of the D1 tier, and it exists to answer one
 * question the Node tiers cannot: the conditional-write primitives ride the
 * host's **SQLite branch** on D1 by inference — `updateIf` is a single
 * `UPDATE … SET data = json_set(…) WHERE … RETURNING data`, and revisions are
 * stamped by the `AFTER INSERT` / `AFTER UPDATE` triggers migration 077 creates
 * on that branch. `better-sqlite3` executes the same SQL against a different
 * engine build, in-process, with a different `randomblob`. Nothing proved that
 * D1's SQLite agrees until this file ran.
 *
 * So the cases below are deliberately the same cases as the Node primitive suite,
 * case for case, so a divergence shows up as one named failing case rather than
 * as a vague "D1 is different" — plus the schema-level assertions the Node tier
 * has no reason to make (the migration set really ran; the triggers really
 * exist; a revision really changes on every write).
 *
 * The Node suite's ten-way compare-and-set case is ported too, with its
 * `runIf(canRace)` guard dropped. It cannot observe a real race on one isolate —
 * see `no-oversell.d1.spec.ts` for what "concurrency" means here — but interleaved
 * is not the same as sequential: all ten attempts are started before any of them
 * writes, so all ten hold the same revision, and "exactly one applies" is a real
 * claim about D1's `WHERE revision = ?` rather than about scheduling. It is the
 * cheapest pin on the primitive the whole design rests on.
 */
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
	collectionOf,
	isStorageQueryError,
	isStorageSerializationError,
	systemClock,
	uuidIdGen,
} from "../../src/index.js";
import { useD1Storage, type StorageLayout } from "./describe-d1.js";

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

const db = useD1Storage(LAYOUT);
const counters = () => db.collection<Counter>("counters");
const ledger = () => db.collection<LedgerEntry>("ledger");

describe("the migrated D1 schema", () => {
	it("carries the plugin-storage table with its revision column", async () => {
		const columns = await sql<{ name: string }>`PRAGMA table_info("_plugin_storage")`.execute(
			db.db,
		);
		expect(columns.rows.map((row) => row.name)).toContain("revision");
	});

	it("carries both revision triggers from the conditional-write migration", async () => {
		// The whole design rests on these two objects existing. They are created by
		// the migration's NON-Postgres branch, which is the branch D1 takes, and a
		// database without them would let every compare-and-set agree with itself.
		const triggers = await sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'emdash_%revision%'
		`.execute(db.db);
		expect(triggers.rows.map((row) => row.name).toSorted()).toEqual([
			"emdash__plugin_storage_revision_insert",
			"emdash__plugin_storage_revision_update",
			"emdash_options_revision_insert",
			"emdash_options_revision_update",
		]);
	});

	it("stamps a fresh non-default revision on insert and on every update", async () => {
		await counters().put("c1", { n: 1, bucket: "a" });
		const inserted = await counters().getVersioned("c1");
		// '0' is the column default: seeing it here would mean NOTHING assigned a
		// revision, which is exactly the silent failure mode rule 1 guards.
		expect(inserted?.revision).not.toBe("0");
		expect(inserted?.revision).not.toBe("");

		await counters().put("c1", { n: 2, bucket: "a" });
		const updated = await counters().getVersioned("c1");
		expect(updated?.revision).not.toBe("0");
		expect(updated?.revision).not.toBe(inserted?.revision);
	});

	it("lets the trigger assign the revision for a writer that supplies none", async () => {
		// Two mechanisms assign revisions, and only one of them is the migration's.
		// `put` and `compareAndSet` stamp a `crypto.randomUUID()` in the repository
		// itself; `updateIf` does NOT touch the column, so the migration's
		// `AFTER UPDATE` trigger is what bumps it there. This case exercises the
		// trigger branch on its own terms, through raw SQL that leaves `revision`
		// at its default — the same path any other writer of this table takes.
		await sql`
			INSERT INTO _plugin_storage (plugin_id, collection, id, data, updated_at)
			VALUES ('otta', 'counters', 'raw', '{"n":1,"bucket":"a"}', '2026-01-01')
		`.execute(db.db);
		const inserted = await counters().getVersioned("raw");
		// The insert trigger's own stamp: 16 random bytes as lowercase hex.
		expect(inserted?.revision).toMatch(/^[0-9a-f]{32}$/);

		await sql`
			UPDATE _plugin_storage SET data = '{"n":2,"bucket":"a"}'
			WHERE plugin_id = 'otta' AND collection = 'counters' AND id = 'raw'
		`.execute(db.db);
		const updated = await counters().getVersioned("raw");
		expect(updated?.revision).toMatch(/^[0-9a-f]{32}$/);
		expect(updated?.revision).not.toBe(inserted?.revision);
	});
});

describe("the in-process id and clock adapters", () => {
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

describe("the StorageAccess port over a real PluginStorageRepository [d1]", () => {
	it("refuses a collection the descriptor never declared", () => {
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
		// `updateIf` is the RETURNING + json_set statement. The `data` it hands back
		// must be the POST-image, or every caller that trusts the returned document
		// (the adapter does) would act on a stale count.
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

	it("leaves the untouched fields of the document alone under a delta", async () => {
		// json_set's other half: a delta rewrites one key of the JSON document and
		// must not flatten, reorder or drop the rest of it.
		await counters().put("stock", { n: 5, bucket: "a", label: "retained" });
		const applied = await counters().updateIf("stock", {
			where: { n: { gte: 3 } },
			delta: { n: { dec: 3 } },
		});
		expect(applied.applied).toBe(true);
		if (applied.applied) expect(applied.data).toEqual({ n: 2, bucket: "a", label: "retained" });
		expect(await counters().get("stock")).toEqual({ n: 2, bucket: "a", label: "retained" });
	});

	it("stamps a new revision on a guarded update, so the two primitives compose", async () => {
		// `updateIf` and `compareAndSet` write the same row through different SQL.
		// If the AFTER UPDATE trigger did not fire for the `json_set` statement, a
		// caller holding a pre-`updateIf` revision would still win a later
		// compare-and-set — a lost update with no error anywhere.
		await counters().put("stock", { n: 5, bucket: "a" });
		const before = await counters().getVersioned("stock");
		const stale = before?.revision ?? "";
		const applied = await counters().updateIf("stock", {
			where: { n: { gte: 1 } },
			delta: { n: { dec: 1 } },
		});
		expect(applied.applied).toBe(true);

		const after = await counters().getVersioned("stock");
		expect(after?.revision).not.toBe(stale);
		expect((await counters().compareAndSet("stock", stale, { n: 99, bucket: "z" })).applied).toBe(
			false,
		);
		expect((await counters().get("stock"))?.n).toBe(4);
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

	it("reports the revision the swap actually landed, not the one it asked for", async () => {
		// `compareAndSet` assigns its own revision — a `crypto.randomUUID()` written
		// in the same statement — and returns it, and that value is what every retry
		// loop re-reads with. What the migration's trigger must NOT do is fire on top
		// of it and overwrite it (its `WHEN` clause guards against exactly that), and
		// a returned revision that did not match the stored row would make the second
		// iteration of a read-modify-write fail forever. Both halves are asserted here.
		await counters().put("c1", { n: 1, bucket: "a" });
		const first = await counters().getVersioned("c1");
		const applied = await counters().compareAndSet("c1", first?.revision ?? "", {
			n: 2,
			bucket: "a",
		});
		if (!applied.applied) throw new Error("unreachable");
		expect((await counters().getVersioned("c1"))?.revision).toBe(applied.revision);
		// And it is usable: a chained swap on the reported revision applies.
		expect(
			(await counters().compareAndSet("c1", applied.revision, { n: 3, bucket: "a" })).applied,
		).toBe(true);
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
		expect(isStorageQueryError(err) && err.field).toBe("label");

		const ordered = await counters()
			.query({ orderBy: { label: "asc" } })
			.catch((e: unknown) => e);
		expect(isStorageQueryError(ordered) && ordered.field).toBe("label");
	});

	it("lets exactly one of ten interleaved compare-and-sets on one revision win", async () => {
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

		// A loser must never apply. It either says `applied: false` or it aborts
		// RETRYABLY, and nothing else is an acceptable way to lose: an unrelated
		// failure would otherwise let this case pass while nine attempts died for
		// nine unrelated reasons.
		for (const outcome of settled) {
			if (outcome.status === "rejected") {
				expect(isStorageSerializationError(outcome.reason)).toBe(true);
			} else {
				expect(typeof outcome.value.applied).toBe("boolean");
			}
		}

		// And the surviving document is the winner's, not a mix of ten writes.
		expect(await counters().get("stock")).toEqual({ n: winners[0], bucket: "a" });
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
});
