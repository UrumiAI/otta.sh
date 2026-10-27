/**
 * The "is THIS worktree's staging site up?" probe behind `siteIsUp()`.
 *
 * Its own module, with no `@playwright/test` import and no env reads, so vitest
 * can load it (`test/site-probe.test.ts`) — the same split as `registry.ts`.
 *
 * PATIENT WITH A SLOW SITE, QUICK WITH AN ABSENT ONE (issue #568). The probe
 * used to give up after 3 s. Under load (a shared VM at load 20-50) `GET /`
 * took 3.0-3.3 s, so a slow-but-alive server was reported as "no staging site
 * from THIS worktree" while it was still serving. Now each request gets
 * `timeoutMs` and a TIMEOUT is retried once. Nothing else is retried:
 *
 *  - a refused connection means nothing listens — answered at once, as before;
 *  - a 5xx, or any non-2xx on the ownership probe, is an answer, not slowness.
 *
 * So an absent site costs what it always did (a refused connect), and only a
 * server that accepts but stalls pays the wait — at most
 * `2 × attempts × timeoutMs`, once per worker (`siteIsUp()` caches).
 */

export interface ProbeBudget {
	/** Per-request timeout, ms. */
	readonly timeoutMs: number;
	/** Tries per request; only a timeout earns another. */
	readonly attempts: number;
}

/** 5 s clears the measured 3.0-3.3 s with headroom; worst case 2 × 2 × 5 = 20 s. */
export const SITE_PROBE: ProbeBudget = { timeoutMs: 5_000, attempts: 2 };

function isTimeout(err: unknown): boolean {
	return err instanceof DOMException && err.name === "TimeoutError";
}

/** GET without following redirects; `undefined` when no answer came. */
async function answer(url: string, budget: ProbeBudget): Promise<Response | undefined> {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(budget.timeoutMs),
			});
			// Only the status matters; release the connection.
			await res.body?.cancel();
			return res;
		} catch (err) {
			if (!isTimeout(err) || attempt >= budget.attempts) return undefined;
		}
	}
}

/**
 * Is a server from THIS worktree (`repoRoot`) answering at `baseUrl`?
 *
 * `/` must answer below 500, then the ownership probe — Vite's `/@fs/` route,
 * which serves only paths inside the dev server's own `fs.allow` roots — must
 * serve OUR absolute path with a 2xx. A sibling worktree's server answers 403,
 * a preview server 404; neither counts. The note above `siteIsUp()` in
 * `harness.ts` records why only 2xx is attribution.
 */
export async function probeSite(
	baseUrl: string,
	repoRoot: string,
	budget: ProbeBudget = SITE_PROBE,
): Promise<boolean> {
	const home = await answer(baseUrl, budget);
	if (home === undefined || home.status >= 500) return false;
	const own = await answer(`${baseUrl}/@fs${repoRoot}/package.json`, budget);
	return own?.ok ?? false;
}
