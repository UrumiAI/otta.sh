/**
 * The write half of B-X1: no document reaches storage carrying text Postgres's
 * `jsonb` cannot read (a lone UTF-16 surrogate, or U+0000), whoever the caller.
 *
 * The guard lives in `collectionOf`, the one place every adapter gets its
 * collection from, so it covers every store and every caller — the public
 * checkout, the admin, the sync hooks, the sweeps — without each of them
 * remembering. It REPAIRS (each offending code unit becomes U+FFFD) rather than
 * refusing, and that is a decision, not leniency: a refusal at this layer would
 * make a document that ALREADY holds such text (written before the guard)
 * unwritable forever — a pending order that could never be expired, its stock held
 * for good — which is the outage this fixes. The refusal a person can act on
 * belongs at the boundary, and lives there (the plugin's `commerce-input.ts`).
 */
import { findIllFormedText } from "@otta-sh/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { collectionOf } from "../src/index.js";
import { IllFormedIdError, isIllFormedIdError } from "../src/well-formed-storage.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const LAYOUT = { notes: { indexes: ["kind", "seq"] } };

interface Note {
	kind: string;
	seq?: number;
	body?: unknown;
}

afterEach(() => {
	vi.restoreAllMocks();
});

/** The id hash a log line carries. */
const tag = (line: string | undefined) => /id#[0-9a-f]{8}/.exec(line ?? "")?.[0];

describeEachDialect("ill-formed text: the write guard", (ctx) => {
	const bound = ctx.useStorage(LAYOUT);
	const notes = () => collectionOf<Note>(bound.storage, "notes");
	/** What is ACTUALLY stored, read past the guard. */
	const rawGet = async (id: string): Promise<unknown> => bound.storage["notes"]?.get(id);

	test("put: a lone surrogate and a NUL, in values and in keys, are stored as U+FFFD", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const doc: Note = {
			kind: "k",
			body: { city: "Ber\uD800lin", lines: ["ok", "a\u0000b"], ["key\uDC00"]: 1 },
		};
		await notes().put("n1", doc);

		expect(await rawGet("n1")).toEqual({
			kind: "k",
			body: { city: "Ber\uFFFDlin", lines: ["ok", "a\uFFFDb"], ["key\uFFFD"]: 1 },
		});
		// The caller's object is never mutated: the repair is a copy.
		expect((doc.body as { city: string }).city).toBe("Ber\uD800lin");
		// A repair is a boundary gap, so it is LOGGED — collection, a hash of the id,
		// and the path, no text.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toMatch(/notes\/id#[0-9a-f]{8}\b/);
		expect(String(warn.mock.calls[0]?.[0])).toContain("body.city");
		expect(String(warn.mock.calls[0]?.[0])).not.toContain("Ber");
	});

	test("compareAndSet: create-if-absent and a guarded replace both store the repaired text", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const created = await notes().compareAndSet("n1", null, { kind: "k", body: "\uDBFFx" });
		expect(created.applied).toBe(true);
		expect(await rawGet("n1")).toEqual({ kind: "k", body: "\uFFFDx" });

		const current = await notes().getVersioned("n1");
		if (current === null || !created.applied) throw new Error("arrange");
		const replaced = await notes().compareAndSet("n1", current.revision, {
			kind: "k",
			body: "y\u0000",
		});
		expect(replaced.applied).toBe(true);
		expect(await rawGet("n1")).toEqual({ kind: "k", body: "y\uFFFD" });
	});

	test("updateIf: a set value is repaired too, and the guard still applies", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await notes().put("n1", { kind: "k", seq: 1, body: "x" });
		const result = await notes().updateIf("n1", {
			where: { kind: "k" },
			set: { body: "\uD83Dz" },
		});
		expect(result.applied).toBe(true);
		expect(await rawGet("n1")).toEqual({ kind: "k", seq: 1, body: "\uFFFDz" });
	});

	test("well-formed text — emoji, other controls, noncharacters — is stored exactly, with no warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const body =
			"caf\u00E9 \uD83D\uDE00 \uD83C\uDDEE\uD83C\uDDF3 \u0001\u001f\u007f \uFFFE\uFFFF \uFFFD";
		await notes().put("n1", { kind: "k", body });
		expect(await rawGet("n1")).toEqual({ kind: "k", body });
		expect(warn).not.toHaveBeenCalled();
	});

	test("everything the guard stored is queryable on this dialect", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const [i, body] of ["\uD800", "\uDC00", "\u0000", "fine"].entries()) {
			await notes().put(`n${String(i)}`, { kind: "k", seq: i, body });
		}
		const page = await notes().query({ where: { kind: "k" }, orderBy: { seq: "asc" } });
		expect(page.items.map((i) => i.id)).toEqual(["n0", "n1", "n2", "n3"]);
		for (const item of page.items) expect(findIllFormedText(item.data)).toBeNull();
		expect(await notes().count({ kind: "k" })).toBe(4);
	});

	describe("ids (review B L1; round 2 A R2-A1): an id that is not well formed can never CREATE a row", () => {
		// Creating under such an id is refused: on Postgres the driver rewrites a lone
		// surrogate to U+FFFD on the way in, so "x\uD800" and "x\uDC00" would name ONE
		// row and the second create would silently overwrite the first. A method that
		// addresses an EXISTING row passes the id through unchanged, exactly as before
		// the guard — an id built from a legacy document's stored text (a reservation's
		// sku, a buyer's email) must still reach that legacy row (see
		// `ill-formed-text-legacy-ids`).
		const BAD_IDS = { "lone high": "x\uD800", "lone low": "x\uDC00", NUL: "x\u0000" };

		test.each(Object.entries(BAD_IDS))(
			"%s: every method that can create a row rejects with a typed error",
			async (_l, id) => {
				const c = notes();
				const calls: Array<[string, () => Promise<unknown>]> = [
					["put", () => c.put(id, { kind: "k" })],
					["compareAndSet(null)", () => c.compareAndSet(id, null, { kind: "k" })],
				];
				for (const [name, call] of calls) {
					const err = await call().then(
						() => new Error(`${name} resolved`),
						(e: unknown) => e,
					);
					expect(err, name).toBeInstanceOf(IllFormedIdError);
					expect(isIllFormedIdError(err), name).toBe(true);
					// The refusal names the collection, never the id's text.
					expect(String((err as Error).message), name).toContain("notes");
					expect(String((err as Error).message), name).not.toContain(id);
					expect(String((err as Error).message), name).not.toContain("x\uFFFD");
				}
				// Nothing was written.
				expect((await bound.storage["notes"]?.query({ limit: 10 }))?.items).toEqual([]);
			},
		);

		test.each(Object.entries(BAD_IDS))(
			"%s: the methods that address an existing row pass the id through and create nothing",
			async (_l, id) => {
				const c = notes();
				expect(await c.get(id)).toBeNull();
				expect(await c.getVersioned(id)).toBeNull();
				expect(await c.delete(id)).toBe(false);
				expect((await c.compareAndDelete(id, "1")).applied).toBe(false);
				expect((await c.compareAndSet(id, "1", { kind: "k" })).applied).toBe(false);
				expect((await c.updateIf(id, { where: { kind: "k" }, set: { body: "x" } })).applied).toBe(
					false,
				);
				expect((await bound.storage["notes"]?.query({ limit: 10 }))?.items).toEqual([]);
			},
		);

		test("two ids that differ only in a lone surrogate can no longer collapse into one NEW row", async () => {
			await expect(notes().put("x\uD800", { kind: "a" })).rejects.toBeInstanceOf(IllFormedIdError);
			await expect(notes().put("x\uDC00", { kind: "b" })).rejects.toBeInstanceOf(IllFormedIdError);
			await expect(notes().compareAndSet("x\uD800", null, { kind: "a" })).rejects.toBeInstanceOf(
				IllFormedIdError,
			);
			await notes().put("x\uFFFD", { kind: "c" });
			expect(await notes().get("x\uFFFD")).toEqual({ kind: "c" });
			// Neither spelling can overwrite the legitimate row either: `put` is refused,
			// and a create-if-absent is refused before it could see the row exists.
			await expect(notes().put("x\uDC00", { kind: "d" })).rejects.toBeInstanceOf(IllFormedIdError);
			expect(await bound.storage["notes"]?.get("x\uFFFD")).toEqual({ kind: "c" });
		});
	});

	test("keys that repair to the same text (review B L2): the already-well-formed key wins, the drop is logged without text", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await notes().put("cart", {
			kind: "c",
			body: {
				mutations: {
					["k\uD800"]: { result: "A" },
					["k\uDC00"]: { result: "B" },
					["k\uFFFD"]: { result: "C" },
				},
			},
		});
		expect(await rawGet("cart")).toEqual({
			kind: "c",
			body: { mutations: { ["k\uFFFD"]: { result: "C" } } },
		});
		const lines = error.mock.calls.map((a) => String(a[0]));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("body.mutations.(key #0)");
		expect(lines[0]).toContain("body.mutations.(key #1)");
		expect(lines[0]).not.toMatch(/k\uFFFD|k\uD800|k\uDC00|cart/);
	});

	test("the log never carries the id or a key's text (review B L3)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await notes().put("victim.person@example.com", {
			kind: "k",
			body: { "buyer@example.com": { ["idem\uD800"]: 1 } },
		});
		await notes().put("victim.person@example.com", { kind: "k", body: "x\u0000" });
		const [first, second] = warn.mock.calls.map((a) => String(a[0]));
		for (const line of [first, second]) {
			expect(line).not.toMatch(/victim|example|buyer|idem/);
		}
		expect(first).toContain("body.(key #0).(key #0)");
		// The hash is stable, so two lines about one document can be matched up.
		expect(tag(first)).toBeDefined();
		expect(tag(first)).toBe(tag(second));
	});

	test("where operands are repaired the way stored text is (review A A5): a lookup by the raw value finds the stored row on every dialect", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await notes().put("n1", { kind: "a\uD800b", seq: 1 });
		expect(await rawGet("n1")).toEqual({ kind: "a\uFFFDb", seq: 1 });
		for (const kind of ["a\uD800b", "a\uDBFFb", "a\u0000b", "a\uFFFDb"]) {
			expect(
				(await notes().query({ where: { kind } })).items.map((i) => i.id),
				kind,
			).toEqual(["n1"]);
			expect(await notes().count({ kind }), kind).toBe(1);
			expect(
				(await notes().query({ where: { kind: { in: ["zzz", kind] } } })).items.map((i) => i.id),
				kind,
			).toEqual(["n1"]);
		}
		expect(
			(await notes().query({ where: { kind: { startsWith: "a\u0000" } } })).items.map((i) => i.id),
		).toEqual(["n1"]);
		const updated = await notes().updateIf("n1", { where: { kind: "a\uDC00b" }, set: { seq: 2 } });
		expect(updated.applied).toBe(true);
	});
	test("a LEGACY row holding the raw text is still found by its raw value (A R2-A3)", async () => {
		// Written past the guard, the way a row written before it was: SQLite (and
		// D1) keep the raw code units, Postgres's driver folded them to U+FFFD.
		await bound.storage["notes"]?.put("legacy", { kind: "k\uD800", seq: 1 });
		await bound.storage["notes"]?.put("legacy-low", { kind: "m\uDC00n", seq: 2 });
		expect((await notes().query({ where: { kind: "k\uD800" } })).items.map((i) => i.id)).toEqual([
			"legacy",
		]);
		expect(await notes().count({ kind: "k\uD800" })).toBe(1);
		expect(
			(await notes().query({ where: { kind: { in: ["k\uD800", "m\uDC00n"] } } })).items
				.map((i) => i.id)
				.toSorted(),
		).toEqual(["legacy", "legacy-low"]);
		const updated = await notes().updateIf("legacy", {
			where: { kind: "k\uD800" },
			set: { seq: 3 },
		});
		expect(updated.applied).toBe(true);
		// A NUL operand matches only the repaired spelling, without an error: Postgres
		// refuses a raw NUL parameter (22021), so the raw spelling is never sent.
		expect(await notes().count({ kind: "k\u0000" })).toBe(await notes().count({ kind: "k\uFFFD" }));
	});
});
