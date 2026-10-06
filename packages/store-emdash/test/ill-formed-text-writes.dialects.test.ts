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
import { afterEach, expect, test, vi } from "vitest";
import { collectionOf } from "../src/index.js";
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
		// A repair is a boundary gap, so it is LOGGED — collection, id and path, no text.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("notes/n1");
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
});
