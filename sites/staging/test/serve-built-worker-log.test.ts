/**
 * `scripts/serve-built-worker.mjs` fails a served build on an error in the
 * Worker's log (#732, #734). Two things in that check are easy to break
 * silently (#738):
 *  - wrangler colours `[ERROR]` even under NO_COLOR, so the colour codes must
 *    be stripped first or the check matches nothing;
 *  - the playground allowlist (a new visitor's empty database logs "no such
 *    table" while EmDash's init migrates it) covers session setup only, never
 *    the page requests after it.
 */
import { describe, expect, test } from "vitest";
import { workerLogFailures } from "../../../scripts/serve-built-worker-log.mjs";

const ESC = "\u001b";
/** wrangler's `[ERROR]` line as it really arrives, colours and all. */
const coloured = (message: string): string =>
	`${ESC}[31m✘ ${ESC}[41;31m[${ESC}[41;97mERROR${ESC}[41;31m]${ESC}[0m ${message}`;
const NO_SUCH_TABLE = "Uncaught Error: no such table: options: SQLITE_ERROR";

describe("workerLogFailures", () => {
	test("a coloured [ERROR] line counts, with its colour removed", () => {
		const log = `ready\n${coloured("boom")}\nGET / 200\n`;
		expect(workerLogFailures(log)).toEqual(["✘ [ERROR] boom"]);
	});

	test("each failure pattern counts; a clean log has none", () => {
		expect(workerLogFailures("GET / 200\nGET /cart 200\n")).toEqual([]);
		expect(workerLogFailures("TypeError: Invalid URL\nUncaught x\n")).toEqual([
			"TypeError: Invalid URL",
			"Uncaught x",
		]);
	});

	test("the playground allowlist drops 'no such table: options' only in playground mode", () => {
		const log = `${NO_SUCH_TABLE}\n${coloured("no such table: _emdash_migrations: SQLITE_ERROR")}\n`;
		expect(workerLogFailures(log)).toHaveLength(2);
		expect(workerLogFailures(log, { playground: true })).toEqual([]);
	});

	test("the playground allowlist does not cover other errors during setup", () => {
		const log = `${NO_SUCH_TABLE}\n${coloured("no such table: products: SQLITE_ERROR")}\n`;
		expect(workerLogFailures(log, { playground: true })).toEqual([
			"✘ [ERROR] no such table: products: SQLITE_ERROR",
		]);
	});

	test("after the setup offset, 'no such table: options' is a failure again", () => {
		const setup = `${NO_SUCH_TABLE}\nPOST /_playground/init 200\n`;
		const log = `${setup}GET / 200\n${NO_SUCH_TABLE}\n`;
		expect(workerLogFailures(log, { playground: true, setupEnd: setup.length })).toEqual([
			NO_SUCH_TABLE,
		]);
	});

	test("without a setup offset (setup never finished) the whole log is setup", () => {
		const log = `${NO_SUCH_TABLE}\n`;
		expect(workerLogFailures(log, { playground: true })).toEqual([]);
	});

	test("a line cut by the offset is checked whole, after setup", () => {
		const log = `ok\n${NO_SUCH_TABLE}\n`;
		const mid = log.indexOf("no such table");
		expect(workerLogFailures(log, { playground: true, setupEnd: mid })).toEqual([NO_SUCH_TABLE]);
	});

	test("an offset inside a colour code does not leave the code behind", () => {
		const log = `ok\n${coloured("boom")}\n`;
		expect(workerLogFailures(log, { setupEnd: log.indexOf("[41;97m") })).toEqual([
			"✘ [ERROR] boom",
		]);
	});
});
