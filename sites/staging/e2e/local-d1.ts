/**
 * The dev server's LOCAL D1, opened directly (issue #659).
 *
 * `dead-store.spec.ts` takes the products table away by renaming it in the
 * SQLite file miniflare keeps under this worktree's `sites/staging/.wrangler`
 * state, the state `astro dev` runs on. There is no binding name, no account
 * and no `--remote` here to get wrong: the only database this module can touch
 * is a file under {@link D1_DIR}.
 *
 * CONCURRENCY. workerd holds the same file open while the dev server runs.
 * That is safe for SQLite: miniflare opens its D1 files in WAL mode, and the
 * `-sqlite-shm` index beside each one is the ordinary shared-memory WAL index,
 * coordinated by POSIX file locks that better-sqlite3 honours too. One
 * `ALTER TABLE … RENAME` is a single write transaction; the `timeout` below
 * waits out a write workerd has in flight rather than failing. The rename also
 * bumps the schema cookie, so workerd's next statement sees the new schema and
 * re-prepares instead of running a cached plan against the old table.
 *
 * HEALING. A run killed between the rename and the restore leaves the table
 * PARKED, and the store then looks dead to every later spec. {@link healLocalD1}
 * puts it back. `global-setup.ts` calls it at the start of every run, and the
 * spec calls it again before it parks anything.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { REPO_ROOT } from "./harness.js";

export const CONTENT_TABLE = "ec_products";
export const PARKED_TABLE = "ec_products_e2e_659_parked";

/** Miniflare keeps each local D1 database as one SQLite file in here. */
export const D1_DIR = join(
	REPO_ROOT,
	"sites/staging/.wrangler/state/v3/d1/miniflare-D1DatabaseObject",
);

/** How long a write waits for workerd's lock before giving up. */
const BUSY_TIMEOUT_MS = 10_000;

export function contentTables(db: Database.Database): Set<string> {
	return new Set(
		db
			.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => row.name),
	);
}

/**
 * The one local D1 file that holds the products table (live or parked), or
 * `undefined` if none does. Every candidate is inspected READ-ONLY; more than
 * one match is an error, because renaming in the wrong database would prove
 * nothing.
 */
export function findContentDbFile(): string | undefined {
	if (!existsSync(D1_DIR)) return undefined;
	const matches: string[] = [];
	for (const file of readdirSync(D1_DIR)) {
		if (!file.endsWith(".sqlite") || file === "metadata.sqlite") continue;
		const path = join(D1_DIR, file);
		const db = new Database(path, { readonly: true, fileMustExist: true });
		try {
			const names = contentTables(db);
			if (names.has(CONTENT_TABLE) || names.has(PARKED_TABLE)) matches.push(path);
		} finally {
			db.close();
		}
	}
	if (matches.length > 1) {
		throw new Error(
			`more than one local D1 file under ${D1_DIR} has a "${CONTENT_TABLE}" table ` +
				`(${matches.join(", ")}); cannot tell which one the dev server reads.`,
		);
	}
	return matches[0];
}

/** {@link findContentDbFile}'s file, reopened read-write; `undefined` if none. */
export function openContentDb(): Database.Database | undefined {
	const path = findContentDbFile();
	if (path === undefined) return undefined;
	return new Database(path, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
}

export function renameTable(db: Database.Database, from: string, to: string): void {
	db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
}

/** Thrown when BOTH tables exist: something wrote a new products table while
 *  the old one was parked, and only a person can say which one is real. */
export class BothTablesError extends Error {}

/**
 * Put a parked products table back. Returns `true` if it did. Throws
 * {@link BothTablesError}, before renaming anything, when both the live and
 * the parked table exist.
 */
export function healParkedTable(db: Database.Database): boolean {
	const names = contentTables(db);
	if (!names.has(PARKED_TABLE)) return false;
	if (names.has(CONTENT_TABLE)) {
		throw new BothTablesError(
			`both "${CONTENT_TABLE}" and "${PARKED_TABLE}" exist in ${db.name}, so an ` +
				`interrupted #659 run parked the table and something then created a new one. ` +
				`Resolve it by hand: keep the one with the products, then drop the empty one ` +
				`or rename the parked one back to "${CONTENT_TABLE}".`,
		);
	}
	renameTable(db, PARKED_TABLE, CONTENT_TABLE);
	return true;
}

/** Open, heal, close. `"absent"` when there is no local D1 with the table. */
export function healLocalD1(): "healed" | "clean" | "absent" {
	const db = openContentDb();
	if (db === undefined) return "absent";
	try {
		return healParkedTable(db) ? "healed" : "clean";
	} finally {
		db.close();
	}
}
