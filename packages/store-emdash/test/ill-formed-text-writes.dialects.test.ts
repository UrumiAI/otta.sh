/**
 * The write half of B-X1: no document reaches Postgres carrying text its `jsonb`
 * cannot read (a lone UTF-16 surrogate, or U+0000), whoever the caller. SQLite and
 * D1 read such text, so there it is stored as given (#447): a repair could re-key
 * a legacy id built from it (see `ill-formed-text-legacy-ids`). Every write logs it
 * on every dialect, since it is a boundary gap either way.
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
import { findIllFormedText, repairIllFormedText } from "@otta-sh/domain";
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
	/** What a write of `written` stores here: repaired on Postgres, as given elsewhere. */
	const storedAs = <T>(written: T): T =>
		ctx.dialect === "postgres" ? repairIllFormedText(written) : written;

	test("put: a lone surrogate and a NUL, in values and in keys, are stored as U+FFFD on Postgres, as given elsewhere", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const doc: Note = {
			kind: "k",
			body: { city: "Ber\uD800lin", lines: ["ok", "a\u0000b"], ["key\uDC00"]: 1 },
		};
		await notes().put("n1", doc);

		expect(await rawGet("n1")).toEqual(
			ctx.dialect === "postgres"
				? { kind: "k", body: { city: "Ber\uFFFDlin", lines: ["ok", "a\uFFFDb"], ["key\uFFFD"]: 1 } }
				: doc,
		);
		// The caller's object is never mutated: the repair is a copy.
		expect((doc.body as { city: string }).city).toBe("Ber\uD800lin");
		// A repair is a boundary gap, so it is LOGGED — collection, a hash of the id,
		// and the path, no text.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toMatch(/notes\/id#[0-9a-f]{8}\b/);
		expect(String(warn.mock.calls[0]?.[0])).toContain("body.city");
		expect(String(warn.mock.calls[0]?.[0])).not.toContain("Ber");
	});

	test("compareAndSet: create-if-absent and a guarded replace both store the text as this dialect needs", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const created = await notes().compareAndSet("n1", null, { kind: "k", body: "\uDBFFx" });
		expect(created.applied).toBe(true);
		expect(await rawGet("n1")).toEqual(storedAs({ kind: "k", body: "\uDBFFx" }));

		const current = await notes().getVersioned("n1");
		if (current === null || !created.applied) throw new Error("arrange");
		const replaced = await notes().compareAndSet("n1", current.revision, {
			kind: "k",
			body: "y\u0000",
		});
		expect(replaced.applied).toBe(true);
		expect(await rawGet("n1")).toEqual(storedAs({ kind: "k", body: "y\u0000" }));
	});

	test("updateIf: a set value is treated the same, and the guard still applies", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await notes().put("n1", { kind: "k", seq: 1, body: "x" });
		const result = await notes().updateIf("n1", {
			where: { kind: "k" },
			set: { body: "\uD83Dz" },
		});
		expect(result.applied).toBe(true);
		expect(await rawGet("n1")).toEqual(storedAs({ kind: "k", seq: 1, body: "\uD83Dz" }));
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
		if (ctx.dialect === "postgres") {
			for (const item of page.items) expect(findIllFormedText(item.data)).toBeNull();
		}
		expect(await notes().count({ kind: "k" })).toBe(4);
	});

	test("an INCONCLUSIVE dialect probe stores the text as given, says so once without data, and asks again next write (#447 review)", async () => {
		// The probe is `get("\u0000")`: Postgres refuses it (22021), SQLite and D1
		// answer null. Any other failure proves nothing — and repairing then could
		// re-key a legacy id on SQLite or D1, which cannot be undone, while text left
		// as given on Postgres is healed by the next read that trips on it.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const inner = bound.storage["notes"];
		if (inner === undefined) throw new Error("arrange");
		let probes = 0;
		const flaky = new Proxy(inner, {
			get(target, prop) {
				const value: unknown = Reflect.get(target, prop, target);
				if (prop !== "get" || typeof value !== "function") {
					return typeof value === "function" ? value.bind(target) : value;
				}
				return async (id: string) => {
					if (id === "\u0000") {
						probes++;
						throw new Error("connection reset while probing");
					}
					return (value as (id: string) => Promise<unknown>).call(target, id);
				};
			},
		});
		const guarded = collectionOf<Note>({ ...bound.storage, notes: flaky }, "notes");
		await guarded.put("n1", { kind: "k", body: "a\uD800b" });
		await guarded.put("n2", { kind: "k", body: "c\uDC00d" });
		expect(probes).toBe(2);
		const n1 = await rawGet("n1");
		expect(findIllFormedText(n1)).toBe("body");
		if (ctx.dialect === "sqlite") {
			expect(n1).toEqual({ kind: "k", body: "a\uD800b" });
		}
		const lines = warn.mock.calls.map((c) => String(c[0]));
		const inconclusive = lines.filter((l) => l.includes("could not tell"));
		expect(inconclusive).toHaveLength(1);
		expect(inconclusive[0]).not.toMatch(/n1|connection reset|a\uD800b/);

		// #478: on Postgres the text left as given is unreadable to `jsonb`, and the
		// NEXT read that casts it heals it (READS HEAL): the query answers in full and
		// both documents are stored repaired afterwards. On SQLite the text stays as
		// given (a repair could re-key a legacy id) and the same read just works.
		const page = await guarded.query({ where: { kind: "k" } });
		expect(page.items.map((i) => i.id).toSorted()).toEqual(["n1", "n2"]);
		if (ctx.dialect === "postgres") {
			expect(await rawGet("n1")).toEqual({ kind: "k", body: "a\uFFFDb" });
			expect(await rawGet("n2")).toEqual({ kind: "k", body: "c\uFFFDd" });
		} else {
			expect(await rawGet("n2")).toEqual({ kind: "k", body: "c\uDC00d" });
		}
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
		const written = {
			kind: "c",
			body: {
				mutations: {
					["k\uD800"]: { result: "A" },
					["k\uDC00"]: { result: "B" },
					["k\uFFFD"]: { result: "C" },
				},
			},
		};
		await notes().put("cart", written);
		if (ctx.dialect !== "postgres") {
			// Nothing is repaired here, so no keys merge and nothing is dropped.
			expect(await rawGet("cart")).toEqual(written);
			expect(error).not.toHaveBeenCalled();
			return;
		}
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
		expect(await rawGet("n1")).toEqual(storedAs({ kind: "a\uD800b", seq: 1 }));
		// On Postgres every spelling that repairs to the stored text finds it; on
		// SQLite the text is stored as given, so only that spelling does.
		const finding =
			ctx.dialect === "postgres" ? ["a\uD800b", "a\uDBFFb", "a\u0000b", "a\uFFFDb"] : ["a\uD800b"];
		for (const kind of finding) {
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
		if (ctx.dialect === "postgres") {
			expect(
				(await notes().query({ where: { kind: { startsWith: "a\u0000" } } })).items.map(
					(i) => i.id,
				),
			).toEqual(["n1"]);
		} else {
			expect(await notes().count({ kind: "a\uFFFDb" })).toBe(0);
		}
		const updated = await notes().updateIf("n1", {
			where: { kind: ctx.dialect === "postgres" ? "a\uDC00b" : "a\uD800b" },
			set: { seq: 2 },
		});
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
