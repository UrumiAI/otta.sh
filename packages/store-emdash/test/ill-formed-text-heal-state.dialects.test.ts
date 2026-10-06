/**
 * The read heal's bookkeeping (review round 1: B L4/L5, A A1/A3).
 *
 * The heal walk is the expensive half of the guard — it pages the WHOLE collection
 * the one way Postgres never casts. Three properties keep it a one-time cost:
 *
 * - **Shared by collection NAME, not by object.** EmDash builds a fresh
 *   `ctx.storage` (fresh collection objects) for every route call and hook, so
 *   keying the in-flight walk by object meant K concurrent requests ran K walks. A
 *   caller that failed before a walk finished retries without walking. The host's
 *   collections expose no database handle, so in production the key is the name
 *   alone (one store per process); a collection that does expose one (a bare
 *   repository, as this harness passes) is keyed by database as well.
 * - **Resumable.** A walk that reaches its page budget remembers where it
 *   stopped, so the next failing call continues past it instead of re-walking the
 *   same pages and failing again forever (a bad row past page 1,000).
 * - **Cooled down.** A walk from the start that reached the end of the collection
 *   and repaired nothing cannot help a retry, so for a while a failing call fails fast instead
 *   of re-walking the collection on every call.
 *
 * The failing host is SIMULATED here (a `where` query that rejects with the
 * Postgres error while a chosen row is still unrepaired), so these run on every
 * dialect; the real Postgres error is covered by `ill-formed-text-reads` and the
 * heal race suite.
 */
import { findIllFormedText } from "@otta-sh/domain";
import { afterEach, expect, test, vi } from "vitest";
import type { StorageCollection } from "../src/index.js";
import { guardWellFormed, HEAL_COOL_DOWN_MS } from "../src/well-formed-storage.js";
import {
	describeEachDialect,
	hostShapedCollection,
	makeSqliteStorage,
} from "./describe-each-dialect.js";

const LAYOUT = { things: { indexes: ["k"] } };

// Each case seeds a few hundred rows one by one, which on Postgres under machine
// load can pass the default 5 s; a timeout is a load artefact, not a finding.
vi.setConfig({ testTimeout: 60_000 });

// The heal state itself is reset after every case by this package's test setup
// (`test/setup.ts`), so no case inherits another's cursor or cool-down.
afterEach(() => {
	vi.restoreAllMocks();
});

const pgError = () =>
	Object.assign(new Error("invalid input syntax for type json"), { code: "22P02" });

interface Counts {
	/** Unfiltered queries: the heal walk's pages. */
	walkPages: number;
}

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let settle: ((value: void) => void) | undefined;
	const promise = new Promise<void>((r) => {
		settle = r;
	});
	return { promise, resolve: () => settle?.() };
}

/**
 * A fresh collection OBJECT over the same rows, the way EmDash hands every request
 * its own. Its filtered queries fail while `blocked()` says so. It carries `raw`'s
 * own fields: a bare repository's database handle, or nothing for a
 * {@link hostShapedCollection} (which is what production hands the guard).
 */
function hostView(
	raw: StorageCollection<unknown>,
	counts: Counts,
	blocked: () => Promise<boolean>,
): StorageCollection<unknown> {
	return {
		...raw,
		get: (id) => raw.get(id),
		getVersioned: (id) => raw.getVersioned(id),
		put: (id, d) => raw.put(id, d),
		delete: (id) => raw.delete(id),
		compareAndSet: (id, r, d) => raw.compareAndSet(id, r, d),
		compareAndDelete: (id, r) => raw.compareAndDelete(id, r),
		count: async (w) => {
			if (await blocked()) throw pgError();
			return raw.count(w);
		},
		updateIf: (id, a) => raw.updateIf(id, a),
		query: async (o) => {
			if (o?.where === undefined && o?.orderBy === undefined) {
				counts.walkPages++;
				return raw.query(o);
			}
			if (await blocked()) throw pgError();
			return raw.query(o);
		},
	};
}

describeEachDialect("ill-formed text: the heal walk's bookkeeping", (ctx) => {
	const bound = ctx.useStorage(LAYOUT);
	const raw = () => bound.storage["things"] as StorageCollection<unknown>;

	async function seedClean(n: number): Promise<void> {
		for (let i = 0; i < n; i++) await raw().put(`r${String(i).padStart(4, "0")}`, { k: "a" });
	}
	const stillBad = async () => findIllFormedText(await raw().get("bad")) !== null;

	test("an error the walk cannot fix re-walks once, then fails FAST for the cool-down (B L4)", async () => {
		await seedClean(250);
		const counts: Counts = { walkPages: 0 };
		let now = 1_000_000;
		const c = guardWellFormed(
			hostView(raw(), counts, async () => true),
			"things",
			{ now: () => now },
		);
		const perCall: number[] = [];
		for (let i = 0; i < 5; i++) {
			const before = counts.walkPages;
			await expect(c.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
			perCall.push(counts.walkPages - before);
		}
		expect(perCall).toEqual([3, 0, 0, 0, 0]);

		// A second request's collection OBJECT is cooled down too: the state is per name.
		const other = guardWellFormed(
			hostView(raw(), counts, async () => true),
			"things",
			{ now: () => now },
		);
		await expect(other.count({ k: "a" })).rejects.toThrow(/type json/);
		expect(counts.walkPages).toBe(3);

		// After the cool-down, one more walk is allowed.
		expect(HEAL_COOL_DOWN_MS).toBe(60_000);
		now += HEAL_COOL_DOWN_MS + 1;
		await expect(c.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
		expect(counts.walkPages).toBe(6);
	});

	test("a walk that repaired something sets no cool-down", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await seedClean(5);
		await raw().put("bad", { k: "a", note: "x\uD800" });
		const counts: Counts = { walkPages: 0 };
		const c = guardWellFormed(hostView(raw(), counts, stillBad), "things");
		expect((await c.query({ where: { k: "a" } })).items).toHaveLength(6);
		// A new legacy-shaped row (planted raw, past the guard) is healed at once.
		await raw().put("bad", { k: "a", note: "y\u0000" });
		expect(await c.count({ k: "a" })).toBe(6);
		expect(counts.walkPages).toBe(2);
	});

	test("a walk that hits its page budget RESUMES where it stopped on the next call (A A1)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await seedClean(250);
		// The bad row is the newest, so it is on the walk's third page.
		await raw().put("bad", { k: "a", note: "x\uDC00" });
		const counts: Counts = { walkPages: 0 };
		const c = guardWellFormed(hostView(raw(), counts, stillBad), "things", { maxPages: 2 });

		await expect(c.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
		expect(counts.walkPages).toBe(2);
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toMatch(/page budget/);

		// The next call does not start over: one page, the row repaired, the read answers.
		const page = await c.query({ where: { k: "a" }, limit: 100 });
		expect(page.items).toHaveLength(100);
		expect(counts.walkPages).toBe(3);
		expect(await stillBad()).toBe(false);
	});

	test("concurrent callers holding DIFFERENT collection objects for one name share one walk (B L5, A A3)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await seedClean(250);
		await raw().put("bad", { k: "a", note: "x\u0000" });
		const counts: Counts = { walkPages: 0 };
		// Two requests, two host collection objects, the same collection name.
		const first = guardWellFormed(hostView(raw(), counts, stillBad), "things");
		const second = guardWellFormed(hostView(raw(), counts, stillBad), "things");
		const results = await Promise.all([
			first.query({ where: { k: "a" } }),
			second.query({ where: { k: "a" } }),
			first.count({ k: "a" }),
			second.count({ k: "a" }),
		]);
		expect(results[2]).toBe(251);
		expect(results[3]).toBe(251);
		// ONE walk: 3 pages of 100 over 251 rows.
		expect(counts.walkPages).toBe(3);
	});

	test("a caller whose query failed BEFORE a walk repaired the row, but noticed AFTER, retries without walking (A R2-A2)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await seedClean(250);
		await raw().put("bad", { k: "a", note: "x\uD800" });
		const counts: Counts = { walkPages: 0 };
		// Two stragglers whose filtered query has SEEN the bad row and is held there,
		// so their failure lands only after the walk below has finished.
		const gates: Array<() => void> = [];
		const seen: Array<Promise<void>> = [];
		const straggler = () => {
			const gate = deferred();
			const sawRow = deferred();
			seen.push(sawRow.promise);
			gates.push(gate.resolve);
			return guardWellFormed(
				hostView(raw(), counts, async () => {
					const bad = await stillBad();
					sawRow.resolve();
					await gate.promise;
					return bad;
				}),
				"things",
			);
		};
		const s1 = straggler();
		const s2 = straggler();
		const late1 = s1.query({ where: { k: "a" } });
		const late2 = s2.count({ k: "a" });
		await Promise.all(seen);

		// Meanwhile a third caller fails, walks (3 pages) and repairs the row.
		const first = guardWellFormed(hostView(raw(), counts, stillBad), "things");
		expect((await first.query({ where: { k: "a" } })).items).toHaveLength(50);
		expect(counts.walkPages).toBe(3);
		expect(await stillBad()).toBe(false);

		// The stragglers' failures land now. A walk finished since their queries
		// began, so each retries at once: no second walk, no false cool-down.
		for (const release of gates) release();
		expect((await late1).items).toHaveLength(50);
		expect(await late2).toBe(251);
		expect(counts.walkPages).toBe(3);

		// No cool-down was armed: a NEW legacy row is still healed on the next read.
		await raw().put("bad", { k: "a", note: "y\u0000" });
		expect(await first.count({ k: "a" })).toBe(251);
		expect(counts.walkPages).toBe(6);
	});

	test("a RESUMED walk that reaches the end clean arms no cool-down: it never saw the rows before its cursor (B L7)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await seedClean(250);
		const counts: Counts = { walkPages: 0 };
		const oldestBad = async () => findIllFormedText(await raw().get("r0000")) !== null;
		let unfixable = true;
		const c = guardWellFormed(
			hostView(raw(), counts, async () => unfixable || (await oldestBad())),
			"things",
			{ maxPages: 2 },
		);
		// An unfixable failure: the walk stops at its 2-page budget and saves its cursor.
		await expect(c.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
		expect(counts.walkPages).toBe(2);

		// A bad row appears BEHIND that cursor (the oldest row, page 1).
		await raw().put("r0000", { k: "a", note: "x\uDC00" });
		unfixable = false;
		// The resumed walk (page 3) reaches the end having seen nothing bad...
		await expect(c.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
		expect(counts.walkPages).toBe(3);
		// ...which proves nothing about pages 1-2, so the next call walks from the
		// start (its 2-page budget) and repairs the row on page 1.
		expect((await c.query({ where: { k: "a" }, limit: 100 })).items).toHaveLength(100);
		expect(counts.walkPages).toBe(5);
		expect(await oldestBad()).toBe(false);
	});

	test("collections that expose their database handle (bare repositories, as this harness passes) never share a cursor, a walk or a cool-down across databases (B L7, A R2-A4)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const other = await makeSqliteStorage(LAYOUT);
		try {
			const rawB = other.storage["things"] as StorageCollection<unknown>;
			// B's rows are OLDER than A's, so a cursor from A's walk would skip them all.
			await rawB.put("b-bad", { k: "a", note: "x\uD800" });
			for (let i = 0; i < 250; i++) await rawB.put(`b${String(i).padStart(4, "0")}`, { k: "a" });
			await new Promise((r) => setTimeout(r, 5));
			await seedClean(250);

			// Database A: unfixable failures walk it in 2-page bites, leaving a cursor.
			const countsA: Counts = { walkPages: 0 };
			const a = guardWellFormed(
				hostView(raw(), countsA, async () => true),
				"things",
				{ maxPages: 2 },
			);
			await expect(a.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
			await expect(a.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
			await expect(a.query({ where: { k: "a" } })).rejects.toThrow(/type json/);

			// Database B, same collection name: its own state, walked from ITS start.
			const countsB: Counts = { walkPages: 0 };
			const bBad = async () => findIllFormedText(await rawB.get("b-bad")) !== null;
			const b = guardWellFormed(hostView(rawB, countsB, bBad), "things", { maxPages: 2 });
			expect(await b.count({ k: "a" })).toBe(251);
			expect(countsB.walkPages).toBe(2);
			expect(await bBad()).toBe(false);
		} finally {
			await other.close();
		}
	});

	test("host-shaped collections (production: no database handle) share heal state by collection NAME, as documented (round 3, A R3-A1 / B L8)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await seedClean(250);
		const counts: Counts = { walkPages: 0 };
		const now = 1_000_000;
		const host = () => hostShapedCollection(raw());
		expect((host() as { db?: unknown }).db).toBeUndefined();
		// The heal still works on the production shape: a legacy row is repaired.
		await raw().put("bad", { k: "a", note: "x\uD800" });
		const first = guardWellFormed(hostView(host(), counts, stillBad), "things", {
			now: () => now,
		});
		expect(await first.count({ k: "a" })).toBe(251);
		expect(await stillBad()).toBe(false);

		// An unfixable failure arms the cool-down for the NAME: a fresh host-shaped
		// object (the next request's) fails fast without walking.
		const pagesBefore = counts.walkPages;
		const failing = guardWellFormed(
			hostView(host(), counts, async () => true),
			"things",
			{
				now: () => now,
			},
		);
		await expect(failing.query({ where: { k: "a" } })).rejects.toThrow(/type json/);
		const walked = counts.walkPages - pagesBefore;
		expect(walked).toBe(3);
		const other = await makeSqliteStorage(LAYOUT);
		try {
			// ...and so does a collection of the same name over ANOTHER database: with
			// no handle to tell them apart, the state is one per process and name.
			const otherDb = hostShapedCollection(other.storage["things"] as StorageCollection<unknown>);
			const elsewhere = guardWellFormed(
				hostView(otherDb, counts, async () => true),
				"things",
				{
					now: () => now,
				},
			);
			await expect(elsewhere.count({ k: "a" })).rejects.toThrow(/type json/);
			expect(counts.walkPages - pagesBefore).toBe(walked);
		} finally {
			await other.close();
		}
	});

	test("a per-document heal that loses every compare-and-set says so once, without the id (A R2-A6)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await raw().put("buyer@example.com", { k: "a", note: "x\uD800" });
		const counts: Counts = { walkPages: 0 };
		const view = hostView(raw(), counts, async () => true);
		const losing: StorageCollection<unknown> = {
			...view,
			// Every repair loses to a (simulated) concurrent writer.
			compareAndSet: async () => ({ applied: false }),
			updateIf: async () => {
				throw Object.assign(new Error("invalid input syntax for type json"), { code: "22P02" });
			},
		};
		const c = guardWellFormed(losing, "things");
		await expect(c.updateIf("buyer@example.com", { where: {}, set: { k: "b" } })).rejects.toThrow(
			/type json/,
		);
		const gaveUp = error.mock.calls.map((a) => String(a[0])).filter((l) => /gave up/.test(l));
		// One line per exhausted heal, not one per attempt: the row's own heal, the
		// walk reaching it, and the row's own heal again on the one retry.
		expect(gaveUp).toHaveLength(3);
		for (const line of gaveUp) {
			expect(line).toMatch(/things\/id#[0-9a-f]{8}/);
			expect(line).not.toMatch(/buyer|example/);
		}
	});
	test("a walk that finds nothing because a WRITER already repaired the row arms no cool-down: the retry answered (heal-race flake)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await seedClean(250);
		await raw().put("bad", { k: "a", note: "x\uD800" });
		const counts: Counts = { walkPages: 0 };
		const gate = deferred();
		const sawRow = deferred();
		const reader = guardWellFormed(
			hostView(raw(), counts, async () => {
				const bad = await stillBad();
				sawRow.resolve();
				await gate.promise;
				return bad;
			}),
			"things",
		);
		const read = reader.count({ k: "a" });
		await sawRow.promise;
		// A real writer (a payment, say) rewrites the row through the guard first.
		const writer = guardWellFormed(hostView(raw(), counts, stillBad), "things");
		await writer.put("bad", { k: "a", note: "paid" });
		gate.resolve();
		// The reader's walk finds nothing unreadable, but its retry answers: the walk
		// was not useless, so no cool-down.
		expect(await read).toBe(251);
		expect(counts.walkPages).toBe(3);
		await raw().put("bad", { k: "a", note: "y\u0000" });
		expect(await writer.count({ k: "a" })).toBe(251);
		expect(counts.walkPages).toBe(6);
	});
});
