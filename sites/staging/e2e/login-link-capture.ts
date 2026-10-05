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

/** One file's row, or `undefined` when the file is not a D1 database with one. */
function readOne(file: string, name: string): CapturedLoginLink | undefined {
	let db: Database.Database | undefined;
	try {
		db = new Database(file, { readonly: true, fileMustExist: true });
		const row = db.prepare("SELECT value FROM options WHERE name = ?").get(name) as
			| { value: string }
			| undefined;
		if (row === undefined) return undefined;
		const value: unknown = JSON.parse(row.value);
		return isCaptured(value) ? value : undefined;
	} catch {
		// No `options` table (not this site's D1), or a file mid-creation.
		return undefined;
	} finally {
		db?.close();
	}
}

export interface ReadCaptureOptions {
	/** The D1 directory; {@link LOCAL_D1_DIR} by default. */
	dir?: string;
	/** Epoch ms: a capture older than this is ignored, so a spec never follows a
	 *  link minted for an earlier request. */
	since?: number;
}

/** The newest link captured for `email`, or `undefined`. */
export function readCapturedLoginLink(
	email: string,
	options: ReadCaptureOptions = {},
): CapturedLoginLink | undefined {
	const dir = options.dir ?? LOCAL_D1_DIR;
	if (!existsSync(dir)) return undefined;
	const name = capturedLoginLinkOptionName(email);
	let newest: CapturedLoginLink | undefined;
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".sqlite") || entry === MINIFLARE_METADATA) continue;
		const found = readOne(join(dir, entry), name);
		if (found === undefined) continue;
		if (options.since !== undefined && Date.parse(found.capturedAt) < options.since) continue;
		if (newest === undefined || Date.parse(found.capturedAt) > Date.parse(newest.capturedAt)) {
			newest = found;
		}
	}
	return newest;
}

/**
 * Poll until a link captured at or after `since` appears for `email`, and
 * return it. The timeout's message names the usual cause: a dev server started
 * without the capture armed (or one with a real email provider configured,
 * which always wins).
 */
export async function waitForCapturedLoginLink(
	email: string,
	options: ReadCaptureOptions & { since: number; timeoutMs?: number },
): Promise<string> {
	const deadline = Date.now() + (options.timeoutMs ?? 10_000);
	for (;;) {
		const found = readCapturedLoginLink(email, options);
		if (found !== undefined) return found.loginUrl;
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(
		`no sign-in link was captured for ${email}. Start the dev server with ` +
			`OTTA_E2E_LOGIN_CAPTURE=1 and no email provider (EMAIL_API_URL unset); ` +
			`playwright.config.ts does both when it boots the stack.`,
	);
}
