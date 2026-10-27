/**
 * The e2e site probe (`e2e/site-probe.ts`, issue #568), against REAL loopback
 * HTTP servers — no fetch stub.
 *
 * The bug: `siteIsUp()` gave up on a 3 s timeout, and under load `GET /` took
 * 3.0-3.3 s, so a slow-but-alive dev server was reported as "no staging site
 * from THIS worktree". The probe now waits longer and retries a TIMEOUT once,
 * while a refused connection (nothing listening) still answers at once and the
 * `/@fs` ownership check still refuses a server from another worktree.
 *
 * The probe's budget is injectable so these cases run in milliseconds; the
 * shipped default is pinned separately.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { probeSite, SITE_PROBE } from "../e2e/site-probe.js";

const REPO_ROOT = "/work/otta-wt-test";
const OWN_PATH = `/@fs${REPO_ROOT}/package.json`;
/** Small, so a hung request costs the suite ~100 ms, not seconds. */
const FAST = { timeoutMs: 100, attempts: 2 } as const;

let servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.map(
			(s) =>
				new Promise<void>((resolve) => {
					s.closeAllConnections();
					s.close(() => resolve());
				}),
		),
	);
	servers = [];
});

type Handler = (req: IncomingMessage, res: ServerResponse, nth: number) => void;

/** A loopback server; `nth` counts requests per path, from 1. */
async function serve(handler: Handler): Promise<{ url: string; hits: Map<string, number> }> {
	const hits = new Map<string, number>();
	const server = createServer((req, res) => {
		const path = req.url ?? "/";
		const nth = (hits.get(path) ?? 0) + 1;
		hits.set(path, nth);
		handler(req, res, nth);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, hits };
}

/** This worktree's dev server: `/` answers, `/@fs` serves OUR path. */
const ours: Handler = (req, res) => {
	res.statusCode = req.url === "/" || req.url === OWN_PATH ? 200 : 403;
	res.end("ok");
};

/** A port nothing listens on: bind, note the port, release it. */
async function refusedUrl(): Promise<string> {
	const { url } = await serve(ours);
	const s = servers.pop();
	await new Promise<void>((resolve) => s?.close(() => resolve()));
	return url;
}

describe("probeSite", () => {
	test("this worktree's server, answering promptly, is up", async () => {
		const { url } = await serve(ours);
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(true);
	});

	test("a slow-but-alive server is up: a timed-out `/` is retried once", async () => {
		const { url, hits } = await serve((req, res, nth) => {
			// The first `/` misses the timeout — the loaded-VM case.
			if (req.url === "/" && nth === 1) {
				setTimeout(() => ours(req, res, nth), FAST.timeoutMs * 3);
				return;
			}
			ours(req, res, nth);
		});
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(true);
		expect(hits.get("/")).toBe(2);
	});

	test("a timed-out ownership probe is retried once too", async () => {
		const { url, hits } = await serve((req, res, nth) => {
			if (req.url === OWN_PATH && nth === 1) {
				setTimeout(() => ours(req, res, nth), FAST.timeoutMs * 3);
				return;
			}
			ours(req, res, nth);
		});
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(true);
		expect(hits.get(OWN_PATH)).toBe(2);
	});

	test("nothing listening is down AT ONCE: a refused connection is not retried", async () => {
		const url = await refusedUrl();
		const started = performance.now();
		// A long budget: if a refusal were waited on or retried, this would show.
		expect(await probeSite(url, REPO_ROOT, { timeoutMs: 5_000, attempts: 2 })).toBe(false);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("a server that never answers is down, and the wait is bounded", async () => {
		const { url, hits } = await serve(() => {
			/* accept, never respond */
		});
		const started = performance.now();
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(false);
		const elapsed = performance.now() - started;
		expect(hits.get("/")).toBe(FAST.attempts);
		expect(hits.has(OWN_PATH)).toBe(false);
		expect(elapsed).toBeGreaterThanOrEqual(FAST.timeoutMs * FAST.attempts - 10);
		expect(elapsed).toBeLessThan(FAST.timeoutMs * FAST.attempts + 1_000);
	});

	test("a 5xx home page is down and is not retried", async () => {
		const { url, hits } = await serve((req, res) => {
			res.statusCode = req.url === "/" ? 503 : 200;
			res.end();
		});
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(false);
		expect(hits.get("/")).toBe(1);
		expect(hits.has(OWN_PATH)).toBe(false);
	});

	test("a server from ANOTHER worktree (403 on our /@fs path) is not ours", async () => {
		const { url, hits } = await serve((req, res) => {
			res.statusCode = req.url === "/" ? 200 : 403;
			res.end();
		});
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(false);
		expect(hits.get(OWN_PATH)).toBe(1);
	});

	test("a server with no /@fs route at all (404, e.g. preview) is not ours", async () => {
		const { url } = await serve((req, res) => {
			res.statusCode = req.url === "/" ? 200 : 404;
			res.end();
		});
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(false);
	});

	test("a redirect is not followed and does not count as ownership", async () => {
		const { url } = await serve((req, res) => {
			if (req.url === "/") {
				res.statusCode = 200;
			} else {
				res.statusCode = 302;
				res.setHeader("location", "/");
			}
			res.end();
		});
		expect(await probeSite(url, REPO_ROOT, FAST)).toBe(false);
	});
});

describe("the shipped probe budget", () => {
	test("one attempt outlasts the measured 3.0-3.3 s loaded-VM `/`", () => {
		expect(SITE_PROBE.timeoutMs).toBeGreaterThan(3_300);
	});

	test("a timeout is retried exactly once", () => {
		expect(SITE_PROBE.attempts).toBe(2);
	});

	test("the worst case (both requests hung) stays under half a minute", () => {
		expect(2 * SITE_PROBE.attempts * SITE_PROBE.timeoutMs).toBeLessThanOrEqual(30_000);
	});
});
