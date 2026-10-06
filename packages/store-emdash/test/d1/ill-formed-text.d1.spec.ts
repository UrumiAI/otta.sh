/**
 * Review R3-B X1 on real D1 (miniflare): the write guard repairs text Postgres
 * cannot store, and a legacy row holding such text neither breaks a query nor
 * blocks a later write. D1's JSON functions read both escapes, so the legacy row
 * is left as it is until something writes it — then the write repairs it.
 */
import { findIllFormedText } from "@otta-sh/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
