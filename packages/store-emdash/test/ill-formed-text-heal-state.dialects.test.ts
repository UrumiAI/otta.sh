/**
 * The read heal's bookkeeping (review round 1: B L4/L5, A A1/A3).
 *
 * The heal walk is the expensive half of the guard — it pages the WHOLE collection
 * the one way Postgres never casts. Three properties keep it a one-time cost:
 *
 * - **Shared by collection NAME, not by object.** EmDash builds a fresh
 *   `ctx.storage` (fresh collection objects) for every route call and hook, so
 *   keying the in-flight walk by object meant K concurrent requests ran K walks.
 * - **Resumable.** A walk that reaches its page budget remembers where it
 *   stopped, so the next failing call continues past it instead of re-walking the
 *   same pages and failing again forever (a bad row past page 1,000).
 * - **Cooled down.** A walk that reached the end of the collection and repaired
 *   nothing cannot help a retry, so for a while a failing call fails fast instead
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
import {
	guardWellFormed,
	HEAL_COOL_DOWN_MS,
	resetHealStateForTests,
} from "../src/well-formed-storage.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const LAYOUT = { things: { indexes: ["k"] } };

afterEach(() => {
	vi.restoreAllMocks();
	resetHealStateForTests();
});

const pgError = () =>
	Object.assign(new Error("invalid input syntax for type json"), { code: "22P02" });

interface Counts {
	/** Unfiltered queries: the heal walk's pages. */
	walkPages: number;
}

/**
 * A fresh host-collection OBJECT over the same rows, the way EmDash hands every
 * request its own. Its filtered queries fail while `blocked()` says so.
 */
function hostView(
	raw: StorageCollection<unknown>,
	counts: Counts,
	blocked: () => Promise<boolean>,
): StorageCollection<unknown> {
	return {
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
});
