/**
 * Serve a request the way Astro does: the site middleware first, then the
 * endpoint as its `next()`. For the endpoint suites whose CSRF cases used to
 * call the endpoint directly — the origin check now lives in the middleware
 * (issue #376), so a cross-origin case must go through it to mean anything.
 *
 * The caller passes `onRequest` from `../src/middleware.js`, imported after
 *
 *   vi.mock("astro:middleware", () => ({ defineMiddleware: <T>(h: T): T => h }));
 *
 * (a hoisted mock belongs in the test file, not in a helper).
 *
 * The suites' hand-built contexts carry no `routePattern` or `cache`; Astro's
 * always does. Every route these suites serve is static, so the pattern is the
 * path.
 */
import type { APIContext } from "astro";

type Middleware = (context: unknown, next: () => Promise<Response>) => Promise<Response>;

export function serve(
	onRequest: unknown,
	context: APIContext,
	endpoint: (context: APIContext) => Response | Promise<Response>,
): Promise<Response> {
	const filled = context as APIContext & { routePattern?: string; cache?: unknown };
	if (filled.routePattern === undefined) {
		Object.assign(filled, { routePattern: filled.url.pathname });
	}
	if (filled.cache === undefined) Object.assign(filled, { cache: { set: () => {} } });
	return (onRequest as Middleware)(filled, async () => endpoint(filled));
}
