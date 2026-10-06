/**
 * Review R3-B X1 on real D1 (miniflare): the write guard repairs text Postgres
 * cannot store, and a legacy row holding such text neither breaks a query nor
 * blocks a later write. D1's JSON functions read both escapes, so the legacy row
 * is left as it is until something writes it — then the write repairs it.
 */
import { findIllFormedText } from "@otta-sh/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isIllFormedIdError } from "../../src/well-formed-storage.js";
import { useD1Storage, type StorageLayout } from "./describe-d1.js";

interface Note {
	kind: string;
	seq: number;
	body: string;
}

const LAYOUT: StorageLayout = { notes: { indexes: ["kind", "seq"] } };

const db = useD1Storage(LAYOUT);
const notes = () => db.collection<Note>("notes");
const raw = () => {
	const collection = db.storage["notes"];
	if (collection === undefined) throw new Error("notes collection missing");
	return collection;
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ill-formed text [d1]", () => {
	it("put and compareAndSet store a lone surrogate or NUL as U+FFFD", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await notes().put("n1", { kind: "k", seq: 1, body: "a\uD800b" });
		await notes().compareAndSet("n2", null, { kind: "k", seq: 2, body: "c\u0000d" });
		expect(await raw().get("n1")).toEqual({ kind: "k", seq: 1, body: "a\uFFFDb" });
		expect(await raw().get("n2")).toEqual({ kind: "k", seq: 2, body: "c\uFFFDd" });
	});

	it("a legacy row breaks no query, and its next write repairs it", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await raw().put("legacy", { kind: "k", seq: 1, body: "x\uDC00" });
		await raw().put("clean", { kind: "k", seq: 2, body: "fine" });

		const page = await notes().query({ where: { kind: "k" }, orderBy: { seq: "asc" } });
		expect(page.items.map((i) => i.id)).toEqual(["legacy", "clean"]);
		expect(await notes().count({ kind: "k" })).toBe(2);

		const current = await notes().getVersioned("legacy");
		if (current === null) throw new Error("arrange");
		const written = await notes().compareAndSet("legacy", current.revision, {
			...current.value,
			seq: 3,
		});
		expect(written.applied).toBe(true);
		expect(findIllFormedText(await raw().get("legacy"))).toBeNull();
	});

	it("an id that is not well formed can never create a row; the other methods pass it through", async () => {
		const c = notes();
		for (const id of ["x\uD800", "x\uDC00", "x\u0000"]) {
			const creating: Array<() => Promise<unknown>> = [
				() => c.put(id, { kind: "k", seq: 1, body: "b" }),
				() => c.compareAndSet(id, null, { kind: "k", seq: 1, body: "b" }),
			];
			for (const call of creating) {
				const err = await call().then(
					() => null,
					(e: unknown) => e,
				);
				expect(isIllFormedIdError(err)).toBe(true);
			}
			expect(await c.get(id)).toBeNull();
			expect(await c.getVersioned(id)).toBeNull();
			expect(await c.delete(id)).toBe(false);
			expect((await c.compareAndDelete(id, "1")).applied).toBe(false);
			expect((await c.compareAndSet(id, "1", { kind: "k", seq: 1, body: "b" })).applied).toBe(
				false,
			);
			expect((await c.updateIf(id, { where: { kind: "k" }, set: { body: "x" } })).applied).toBe(
				false,
			);
		}
		expect((await raw().query({ limit: 10 })).items).toEqual([]);
	});

	it("a legacy row keyed by an ill-formed id is still addressable, and found by its raw text (A R2-A1, R2-A3)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await raw().put("s\uD800", { kind: "k\uDC00", seq: 1, body: "b" });
		const c = notes();
		expect(findIllFormedText(await c.get("s\uD800"))).toBe("kind");
		// The raw where operand still finds the legacy row, before anything rewrites it.
		// (D1 hands the id back as its own spelling of the lone surrogate, so the
		// count is what is compared, never the text: a lone surrogate in an assertion
		// message breaks the pool's WebSocket.)
		expect((await c.query({ where: { kind: "k\uDC00" } })).items).toHaveLength(1);
		expect(await c.count({ kind: "k\uDC00" })).toBe(1);
		const current = await c.getVersioned("s\uD800");
		if (current === null) throw new Error("legacy row not addressable");
		const written = await c.compareAndSet("s\uD800", current.revision, {
			...current.value,
			seq: 2,
		});
		expect(written.applied).toBe(true);
		expect((await c.updateIf("s\uD800", { where: {}, set: { seq: 3 } })).applied).toBe(true);
		// Re-written repaired, and still found by the same lookup.
		expect(findIllFormedText(await raw().get("s\uD800"))).toBeNull();
		expect((await raw().get("s\uD800")) as Note | null).toMatchObject({ seq: 3 });
		expect(await c.count({ kind: "k\uDC00" })).toBe(1);
		expect(await c.delete("s\uD800")).toBe(true);
	});

	it("keys that repair to the same text keep the already-well-formed one; a raw where operand finds the repaired row", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await db.collection<Record<string, unknown>>("notes").put("n1", {
			kind: "a\uD800b",
			seq: 1,
			body: { ["k\uD800"]: "A", ["k\uDC00"]: "B", ["k\uFFFD"]: "C" },
		});
		expect(await raw().get("n1")).toEqual({
			kind: "a\uFFFDb",
			seq: 1,
			body: { ["k\uFFFD"]: "C" },
		});
		expect(error).toHaveBeenCalledTimes(1);
		const page = await notes().query({ where: { kind: "a\uDBFFb" } });
		expect(page.items.map((i) => i.id)).toEqual(["n1"]);
	});
});
