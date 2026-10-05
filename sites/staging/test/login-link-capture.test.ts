/**
 * The e2e harness's reader for the dev-only login-link capture (e2e follow-up
 * to issue #378).
 *
 * The plugin keeps the link in its kv (`dev-login-capture.ts`); EmDash keeps
 * plugin kv in the D1 `options` table as `plugin:otta:<key>`; under `astro dev`
 * that D1 is a SQLite file in `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`
 * beside miniflare's own `metadata.sqlite`. The reader finds the row there. It
 * runs for real in `account-signed-in.spec.ts`; what is pinned here, on real
 * SQLite files, is that it reads the right row from the right file and refuses
 * a link older than the request it is waiting for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	capturedLoginLinkOptionName,
	readCapturedLoginLink,
	waitForCapturedLoginLink,
} from "../e2e/login-link-capture.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "otta-login-capture-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A D1-shaped file with an `options` table holding `rows`. */
function d1File(name: string, rows: Record<string, unknown>): void {
	const db = new Database(join(dir, name));
	db.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const insert = db.prepare("INSERT INTO options (name, value) VALUES (?, ?)");
	for (const [key, value] of Object.entries(rows)) insert.run(key, JSON.stringify(value));
	db.close();
}

const EMAIL = "Shopper@Example.test";
const NAME = capturedLoginLinkOptionName(EMAIL);

describe("capturedLoginLinkOptionName", () => {
	test("is EmDash's plugin-kv row name for the plugin's capture key", () => {
		expect(NAME).toBe("plugin:otta:e2e:loginLink:shopper@example.test");
	});
});

describe("readCapturedLoginLink", () => {
	test("finds the row in the D1 file, skipping miniflare's metadata and table-less files", () => {
		new Database(join(dir, "metadata.sqlite")).close();
		new Database(join(dir, "empty.sqlite")).close();
		d1File("abc123.sqlite", {
			[NAME]: {
				loginUrl: "http://127.0.0.1:4650/account/verify?x=1",
				capturedAt: "2026-10-05T10:00:00.000Z",
			},
			"plugin:otta:e2e:loginLink:someone-else@example.test": {
				loginUrl: "http://127.0.0.1:4650/account/verify?x=other",
				capturedAt: "2026-10-05T11:00:00.000Z",
			},
		});
		expect(readCapturedLoginLink(EMAIL, { dir })?.loginUrl).toBe(
			"http://127.0.0.1:4650/account/verify?x=1",
		);
	});

	test("nothing captured, no state directory, or a malformed row ⇒ undefined", () => {
		expect(readCapturedLoginLink(EMAIL, { dir })).toBeUndefined();
		expect(readCapturedLoginLink(EMAIL, { dir: join(dir, "missing") })).toBeUndefined();
		d1File("abc123.sqlite", { [NAME]: { loginUrl: 42 } });
		expect(readCapturedLoginLink(EMAIL, { dir })).toBeUndefined();
	});

	test("the newest capture wins across files, and one older than `since` is refused", () => {
		d1File("a.sqlite", {
			[NAME]: { loginUrl: "http://127.0.0.1/old", capturedAt: "2026-10-05T10:00:00.000Z" },
		});
		d1File("b.sqlite", {
			[NAME]: { loginUrl: "http://127.0.0.1/new", capturedAt: "2026-10-05T10:05:00.000Z" },
		});
		expect(readCapturedLoginLink(EMAIL, { dir })?.loginUrl).toBe("http://127.0.0.1/new");
		expect(
			readCapturedLoginLink(EMAIL, { dir, since: Date.parse("2026-10-05T10:06:00.000Z") }),
		).toBeUndefined();
	});
});

describe("waitForCapturedLoginLink", () => {
	test("gives up after its timeout, naming the variable that arms the capture", async () => {
		await expect(
			waitForCapturedLoginLink(EMAIL, { dir, since: 0, timeoutMs: 300 }),
		).rejects.toThrow(/OTTA_E2E_LOGIN_CAPTURE=1/);
	});

	test("returns the link once it lands", async () => {
		setTimeout(() => {
			d1File("abc.sqlite", {
				[NAME]: { loginUrl: "http://127.0.0.1/late", capturedAt: new Date().toISOString() },
			});
		}, 100);
		const since = Date.now() - 1_000;
		expect(await waitForCapturedLoginLink(EMAIL, { dir, since, timeoutMs: 5_000 })).toBe(
			"http://127.0.0.1/late",
		);
	});
});
