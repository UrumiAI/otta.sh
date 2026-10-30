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
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const CONTENT_TABLE = "ec_products";
export const PARKED_TABLE = "ec_products_e2e_659_parked";

/** Miniflare keeps each local D1 database as one SQLite file in here: this
 *  worktree's `sites/staging/.wrangler` state. Resolved from this file, not
 *  through `./harness.js`, so the unit tier can import this module without
 *  Playwright. */
export const D1_DIR = fileURLToPath(
	new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url),
).replace(/\/$/, "");

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

/** Every local D1 file in `dir` that holds the products table, live or parked
 *  (each inspected READ-ONLY), and the error for each file that could not be
 *  read. One unreadable file does not hide the others. */
function candidates(dir: string): { paths: string[]; errors: unknown[] } {
	const paths: string[] = [];
	const errors: unknown[] = [];
	if (!existsSync(dir)) return { paths, errors };
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".sqlite") || file === "metadata.sqlite") continue;
		const path = join(dir, file);
		try {
			const db = new Database(path, { readonly: true, fileMustExist: true });
			try {
				const names = contentTables(db);
				if (names.has(CONTENT_TABLE) || names.has(PARKED_TABLE)) paths.push(path);
			} finally {
				db.close();
			}
		} catch (err) {
			errors.push(err);
		}
	}
	return { paths, errors };
}

/**
 * The one local D1 file that holds the products table (live or parked), or
 * `undefined` if none does. More than one match is an error HERE, where the
 * spec must choose which database to break: renaming in the wrong one would
 * prove nothing. (The heal has no such choice to make; it visits them all.)
 */
export function findContentDbFile(dir: string = D1_DIR): string | undefined {
	const { paths: matches, errors } = candidates(dir);
	if (errors.length > 0) throw errors[0];
	if (matches.length > 1) {
		throw new Error(
			`more than one local D1 file under ${dir} has a "${CONTENT_TABLE}" table ` +
				`(${matches.join(", ")}); cannot tell which one the dev server reads.`,
		);
	}
	return matches[0];
}

/** {@link findContentDbFile}'s file, reopened read-write; `undefined` if none. */
export function openContentDb(dir: string = D1_DIR): Database.Database | undefined {
	const path = findContentDbFile(dir);
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

/**
 * Heal EVERY local D1 file in `dir`: each one holding only the parked table
 * gets it renamed back. A stale file from an earlier `database_id` is healed
 * like the live one, and never stops the others being healed. Returns the
 * paths it healed. Once every file has been visited it throws: a
 * {@link BothTablesError} if any file holds both tables, or the first other
 * error (an unreadable file, a lock it could not get).
 */
export function healLocalD1(dir: string = D1_DIR): string[] {
	const healed: string[] = [];
	const { paths, errors } = candidates(dir);
	for (const path of paths) {
		try {
			const db = new Database(path, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
			try {
				if (healParkedTable(db)) healed.push(path);
			} finally {
				db.close();
			}
		} catch (err) {
			errors.push(err);
		}
	}
	const first = errors.find((err) => err instanceof BothTablesError) ?? errors[0];
	if (first !== undefined) throw first;
	return healed;
}

/**
 * `global-setup.ts`'s heal, with its gate rule. ANY heal error (both tables in
 * one file, an unreadable file, a lock it could not get) throws only when
 * `strict` (a gate run: `OTTA_E2E_SEED=1` or `OTTA_E2E_REQUIRE_SITE=1`).
 * Otherwise it warns and the run goes on, so a bare `pnpm test:e2e` and its
 * server-free gates never fail over leftover local state. Product specs may
 * then skip (or fail) until the leftover is resolved by hand.
 */
export function healOrWarn(
	strict: boolean,
	dir: string = D1_DIR,
	log: Pick<Console, "info" | "warn"> = console,
): string[] {
	try {
		const healed = healLocalD1(dir);
		for (const path of healed) {
			log.info(`[e2e] healed: renamed ${PARKED_TABLE} back to ${CONTENT_TABLE} in ${path} (#659).`);
		}
		return healed;
	} catch (err) {
		if (strict) throw err;
		log.warn(
			`[e2e] could not heal the local D1 after #659's dead-store spec; product specs may ` +
				`skip until this is resolved: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}
