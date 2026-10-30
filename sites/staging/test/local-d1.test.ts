/**
 * `e2e/local-d1.ts`: the heal that `e2e/global-setup.ts` runs before every e2e
 * run (#659), over real SQLite files in a temp directory laid out like
 * miniflare's D1 state.
 *
 * THE BARE-RUN CONTRACT. Leftover local state (a stale D1 file from an earlier
 * `database_id`, a file holding both tables, a file that is not a database)
 * must never fail a run that is not a gate. It is healed where it can be, and
 * warned about where it cannot.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BothTablesError,
	CONTENT_TABLE,
	contentTables,
	findContentDbFile,
	healLocalD1,
	healOrWarn,
	PARKED_TABLE,
} from "../e2e/local-d1.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "otta-local-d1-"));
	// miniflare's own bookkeeping file, which the heal must leave alone.
	new Database(join(dir, "metadata.sqlite")).close();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A D1-shaped file holding `tables`, each a products table with one row. */
function d1File(name: string, tables: string[]): string {
	const path = join(dir, `${name}.sqlite`);
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	for (const table of tables) {
		db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY); INSERT INTO "${table}" VALUES ('a')`);
	}
	db.close();
	return path;
}

function tablesIn(path: string): string[] {
	const db = new Database(path, { readonly: true });
	try {
		return [...contentTables(db)].toSorted();
	} finally {
		db.close();
	}
}

const quiet = () => ({ info: vi.fn(), warn: vi.fn() });

describe("healLocalD1", () => {
	it("heals EVERY file that holds only the parked table, the stale one as well as the live one", () => {
		const live = d1File("live", [PARKED_TABLE]);
		const stale = d1File("stale", [PARKED_TABLE]);

		expect(healLocalD1(dir).toSorted()).toEqual([live, stale].toSorted());
		expect(tablesIn(live)).toEqual([CONTENT_TABLE]);
		expect(tablesIn(stale)).toEqual([CONTENT_TABLE]);
	});

	it("leaves a whole store alone", () => {
		const live = d1File("live", [CONTENT_TABLE]);
		expect(healLocalD1(dir)).toEqual([]);
		expect(tablesIn(live)).toEqual([CONTENT_TABLE]);
	});

	it("heals the others before it reports a file holding both tables, and renames nothing in that one", () => {
		const both = d1File("both", [CONTENT_TABLE, PARKED_TABLE]);
		const parked = d1File("parked", [PARKED_TABLE]);

		expect(() => healLocalD1(dir)).toThrow(BothTablesError);
		expect(tablesIn(both)).toEqual([CONTENT_TABLE, PARKED_TABLE].toSorted());
		expect(tablesIn(parked)).toEqual([CONTENT_TABLE]);
	});

	it("is not stopped by a file that is not a database", () => {
		writeFileSync(join(dir, "junk.sqlite"), "not a database, just bytes ".repeat(200));
		const parked = d1File("parked", [PARKED_TABLE]);

		expect(() => healLocalD1(dir)).toThrow();
		expect(tablesIn(parked)).toEqual([CONTENT_TABLE]);
	});
});

describe("healOrWarn: global-setup's gate rule", () => {
	it("a bare run (not a gate) warns and goes on, whatever the leftover", () => {
		d1File("both", [CONTENT_TABLE, PARKED_TABLE]);
		writeFileSync(join(dir, "junk.sqlite"), "not a database, just bytes ".repeat(200));
		const parked = d1File("parked", [PARKED_TABLE]);
		const log = quiet();

		expect(() => healOrWarn(false, dir, log)).not.toThrow();
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(String(log.warn.mock.calls[0]?.[0])).toContain("product specs may skip");
		expect(tablesIn(parked)).toEqual([CONTENT_TABLE]);
	});

	it("a gate run throws on the same leftover", () => {
		d1File("both", [CONTENT_TABLE, PARKED_TABLE]);
		expect(() => healOrWarn(true, dir, quiet())).toThrow(BothTablesError);
	});

	it("reports each file it healed", () => {
		const a = d1File("a", [PARKED_TABLE]);
		const b = d1File("b", [PARKED_TABLE]);
		const log = quiet();

		expect(healOrWarn(true, dir, log).toSorted()).toEqual([a, b].toSorted());
		expect(log.info).toHaveBeenCalledTimes(2);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("does nothing, quietly, where there is no local D1 at all", () => {
		const log = quiet();
		expect(healOrWarn(true, join(dir, "missing"), log)).toEqual([]);
		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe("findContentDbFile: the spec's choice of ONE file to break", () => {
	it("refuses when more than one file holds the products table", () => {
		d1File("live", [CONTENT_TABLE]);
		d1File("stale", [CONTENT_TABLE]);
		expect(() => findContentDbFile(dir)).toThrow(/more than one local D1 file/);
	});

	it("names the one file when there is one", () => {
		const live = d1File("live", [CONTENT_TABLE]);
		expect(findContentDbFile(dir)).toBe(live);
	});
});
