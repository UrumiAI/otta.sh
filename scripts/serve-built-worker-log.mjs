/**
 * The log check `serve-built-worker.mjs` applies to the served Worker (#732,
 * #734, #738): which lines of wrangler's output mean the Worker failed, even
 * behind a non-5xx answer.
 */

/** What in the Worker's log means it failed. */
export const LOG_FAILURES = [/Invalid URL/, /\[ERROR\]/, /Uncaught/];

/**
 * Playground errors that are not failures, during session setup only. A new
 * visitor's database is empty, and EmDash's playground init
 * (`@emdash-cms/cloudflare`, `initializePlayground`) reads `options` and the
 * migrations table before it migrates, catching the "no such table" itself.
 * The read runs inside the visitor's Durable Object, which logs the error as
 * uncaught when it crosses the RPC boundary. After setup the same error means a
 * visitor's database was left unmigrated, so it counts again.
 */
export const PLAYGROUND_EXPECTED = [/no such table: (options|_emdash_migrations): SQLITE_ERROR/];

/** Lines with colour codes removed (wrangler colours `[ERROR]` even under NO_COLOR). */
function lines(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
}

const failing = (line) => LOG_FAILURES.some((re) => re.test(line));
const expected = (line) => PLAYGROUND_EXPECTED.some((re) => re.test(line));

/**
 * The log lines that count against the Worker. In playground mode the lines
 * before `setupEnd` (the log's length once the session was set up; the whole
 * log when it is not given) may carry `PLAYGROUND_EXPECTED` errors; every line
 * from `setupEnd` on is checked against `LOG_FAILURES` alone. A line that
 * `setupEnd` falls inside is checked whole, as after setup.
 * @param {string} log
 * @param {{ playground?: boolean, setupEnd?: number }} [options]
 * @returns {string[]}
 */
export function workerLogFailures(log, { playground = false, setupEnd } = {}) {
	const end = setupEnd === undefined ? log.length : Math.min(Math.max(setupEnd, 0), log.length);
	// Back to the start of the line `end` falls inside (never inside a colour code).
	const split = end === log.length ? end : log.lastIndexOf("\n", end - 1) + 1;
	const setup = lines(log.slice(0, split)).filter(
		(line) => failing(line) && !(playground && expected(line)),
	);
	const after = lines(log.slice(split)).filter(failing);
	return [...setup, ...after];
}
