/**
 * Read a sign-in link the dev server CAPTURED instead of emailing (e2e
 * follow-up to issue #378).
 *
 * THE OTHER HALF OF `packages/plugin/src/email/dev-login-capture.ts`. A dev
 * server started with `OTTA_E2E_LOGIN_CAPTURE=1` (which `playwright.config.ts`
 * sets on a stack it boots) and no email provider keeps each login link in the
 * plugin's kv instead of mailing it. EmDash stores plugin kv in the D1
 * `options` table as `plugin:<pluginId>:<key>`, and under `astro dev` that D1 is
 * a SQLite file under `sites/staging/.wrangler/state/v3/d1/`. This module reads
 * the row from that file.
 *
 * WHY THE FILE AND NOT A ROUTE. A route would have to exist in the plugin's
 * route table, and a route that answers with sign-in links is exactly what
 * must never reach a deployment. Reading the dev server's own database file
 * from the same machine needs no route at all: nothing over HTTP can fetch a
 * captured link, armed or not.
 *
 * Opened READ-ONLY, one short-lived handle per read. The dev server's workerd
 * keeps the file open in WAL mode; SQLite's own locking makes a concurrent
 * reader safe, and a read sees every transaction committed before it started
 * (the login request's write commits before its response is sent).
 *
 * READ-ONLY, ALWAYS: the harness never writes to that file. It is a Durable
 * Object's database, workerd owns it, and a write from outside behind its back
 * is not a thing to rely on. Old captures are pruned by the plugin itself
 * (`DEV_LOGIN_CAPTURE_MAX_ROWS`), from inside the server.
 *
 * TWO DIFFERENT FAILURES, TOLD APART. A missing D1 directory, or no file in it
 * with an `options` table, means the LAYOUT is not what this reader assumes (a
 * miniflare or EmDash change, or a server that is not `astro dev`): that throws
 * AT ONCE, as a {@link CaptureLayoutError} naming the directory and what is in
 * it. A layout that is fine but has no row for the address is the ordinary
 * "capture not armed" case, reported when the wait times out, with anything
 * unexpected the reads met on the way.
 *
 * NO PLAYWRIGHT AND NO ENVIRONMENT AT LOAD, like `registry.ts`: the unit suite
 * imports this file (`test/login-link-capture.test.ts`).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devLoginCaptureKey, OTTA_PLUGIN_ID, type CapturedLoginLink } from "@otta-sh/plugin";
import Database from "better-sqlite3";

/** Where `astro dev` keeps its local D1 databases (miniflare's layout). */
export const LOCAL_D1_DIR = fileURLToPath(
	new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url),
);

/** miniflare's own bookkeeping file in that directory — never a D1 database. */
const MINIFLARE_METADATA = "metadata.sqlite";

/** The local D1 is not laid out the way this reader assumes. Thrown at once:
 *  waiting would not change it. */
export class CaptureLayoutError extends Error {
	override name = "CaptureLayoutError";
}

/** The `options` row name EmDash gives the plugin's kv key for `email`. */
export function capturedLoginLinkOptionName(email: string): string {
	return `plugin:${OTTA_PLUGIN_ID}:${devLoginCaptureKey(email)}`;
}

function isCaptured(value: unknown): value is CapturedLoginLink {
	if (value === null || typeof value !== "object") return false;
	const { loginUrl, capturedAt } = value as Record<string, unknown>;
	return (
		typeof loginUrl === "string" &&
		loginUrl.length > 0 &&
		typeof capturedAt === "string" &&
		Number.isFinite(Date.parse(capturedAt))
	);
}

/** What one file held: its tables, the row if any, and anything unexpected. */
interface FileRead {
	file: string;
	tables: string[];
	hasOptions: boolean;
	found?: CapturedLoginLink;
	problem?: string;
}

function readOne(dir: string, entry: string, name: string): FileRead {
	const read: FileRead = { file: entry, tables: [], hasOptions: false };
	let db: Database.Database | undefined;
	try {
		db = new Database(join(dir, entry), { readonly: true, fileMustExist: true });
		read.tables = (
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		read.hasOptions = read.tables.includes("options");
		if (!read.hasOptions) return read;
		const row = db.prepare("SELECT value FROM options WHERE name = ?").get(name) as
			| { value: string }
			| undefined;
		if (row === undefined) return read;
		const value: unknown = JSON.parse(row.value);
		if (isCaptured(value)) read.found = value;
		else read.problem = `${entry}: the ${name} row is not a captured link`;
	} catch (err) {
		read.problem = `${entry}: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		db?.close();
	}
	return read;
}

export interface ReadCaptureOptions {
	/** The D1 directory; {@link LOCAL_D1_DIR} by default. */
	dir?: string;
	/** Epoch ms: a capture older than this is ignored, so a spec never follows a
	 *  link minted for an earlier request. */
	since?: number;
}

/** One pass over the D1 files. Throws {@link CaptureLayoutError} when the
 *  layout is wrong; otherwise the newest usable link, and what went wrong. */
function scan(
	email: string,
	options: ReadCaptureOptions,
): { found?: CapturedLoginLink; problems: string[] } {
	const dir = options.dir ?? LOCAL_D1_DIR;
	if (!existsSync(dir)) {
		throw new CaptureLayoutError(
			`the local D1 directory ${dir} does not exist. Is the site running under \`astro dev\` ` +
				`from this worktree (miniflare keeps D1 there)?`,
		);
	}
	const name = capturedLoginLinkOptionName(email);
	const reads = readdirSync(dir)
		.filter((entry) => entry.endsWith(".sqlite") && entry !== MINIFLARE_METADATA)
		.map((entry) => readOne(dir, entry, name));
	if (!reads.some((read) => read.hasOptions)) {
		const seen =
			reads.length === 0
				? "no database files"
				: reads
						.map(
							(read) =>
								`${read.file} (tables: ${read.tables.join(", ") || "none"}` +
								`${read.problem === undefined ? "" : `; ${read.problem}`})`,
						)
						.join("; ");
		throw new CaptureLayoutError(
			`no database in ${dir} has an \`options\` table, where EmDash keeps plugin kv. ` +
				`Found: ${seen}. The miniflare or EmDash storage layout this reader assumes has changed.`,
		);
	}
	const problems = reads.flatMap((read) => (read.problem === undefined ? [] : [read.problem]));
	let found: CapturedLoginLink | undefined;
	for (const read of reads) {
		const candidate = read.found;
		if (candidate === undefined) continue;
		if (options.since !== undefined && Date.parse(candidate.capturedAt) < options.since) continue;
		if (found === undefined || Date.parse(candidate.capturedAt) > Date.parse(found.capturedAt)) {
			found = candidate;
		}
	}
	return found === undefined ? { problems } : { found, problems };
}

/** The newest link captured for `email`, or `undefined`. Throws
 *  {@link CaptureLayoutError} when the local D1 is not laid out as assumed. */
export function readCapturedLoginLink(
	email: string,
	options: ReadCaptureOptions = {},
): CapturedLoginLink | undefined {
	return scan(email, options).found;
}

/**
 * Poll until a link captured at or after `since` appears for `email`, and
 * return it. A layout problem throws at once. The timeout's message names the
 * usual cause — a dev server started without the capture armed, or with a real
 * email provider, which always wins — plus anything unexpected the reads met.
 */
export async function waitForCapturedLoginLink(
	email: string,
	options: ReadCaptureOptions & { since: number; timeoutMs?: number },
): Promise<string> {
	const deadline = Date.now() + (options.timeoutMs ?? 10_000);
	let problems: string[] = [];
	for (;;) {
		const result = scan(email, options);
		if (result.found !== undefined) return result.found.loginUrl;
		problems = result.problems;
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(
		`no sign-in link was captured for ${email}. Start the dev server with ` +
			`OTTA_E2E_LOGIN_CAPTURE=1 and no email provider (EMAIL_API_URL unset); ` +
			`playwright.config.ts does both when it boots the stack.` +
			(problems.length > 0 ? ` Unexpected while reading: ${problems.join("; ")}.` : ""),
	);
}
