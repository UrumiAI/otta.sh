/**
 * The TRANSITIONAL build-time commerce mode (work order 02, D6).
 *
 * ⚠ THIS WHOLE MODULE IS DELETED AT INC-D3b, together with
 * `__OTTA_COMMERCE_MODE__`, the mode branch in `make-commerce-client.ts`,
 * `COMMERCE_SERVICE_BASE_URL` and the derivation of `ALLOWED_HOSTS` from it,
 * `HttpCommerceClient`, and the four admin HTTP clients
 * (`admin-orders-client`, `admin-products-client`, `admin-rules-client`,
 * `reporting-client`). It exists for exactly one reason: so the extracted
 * `commerceClientContract` can be run against BOTH the HTTP client and the
 * in-process client, proving them behaviourally identical before the HTTP one
 * is removed. **Nobody may build on this flag as permanent architecture** —
 * the end state is one deployable, one mode, no service.
 *
 * WHY IT LIVES HERE AND NOT IN `manifest.ts`. The workerd sandbox harness
 * (`test/sandbox/harness.ts`) does not bundle `src/manifest.ts`; it writes a
 * hand-rolled COPY of that module's exported surface with the service URL and
 * allowed hosts baked in. Anything the harness copy does not declare would
 * simply be missing from the sandbox bundle, so the mode resolution needs a
 * module of its own that the harness bundles for real.
 *
 * SANDBOX-CLEAN. No env read, no IO, no host import — a compile-time global
 * behind a `typeof` guard, exactly as `manifest.ts` already resolves
 * `__OTTA_COMMERCE_SERVICE_URL__`.
 */

/** The two transports. `"in-process"` is the end state; `"http"` is what is
 *  being removed. */
export type CommerceMode = "http" | "in-process";

/**
 * Compile-time override hook: a deploying site injects the mode into the plugin
 * bundle via Vite `define: { __OTTA_COMMERCE_MODE__: '"http"' }`
 * (`sites/staging/astro.config.ts`). The `typeof` guard makes the undeclared
 * global safe wherever no bundler defines it — the plain `tsdown` dist, this
 * package's vitest run, and the sandbox harness — so every pre-existing test
 * path resolves to the default below and nothing about today's behaviour moves.
 */
declare const __OTTA_COMMERCE_MODE__: string | undefined;

/** Absent or empty define ⇒ the HTTP transport, i.e. exactly today's
 *  behaviour. */
export const COMMERCE_MODE_DEFAULT: CommerceMode = "http";

/**
 * Pure resolution (unit-tested without a bundler in the loop).
 *
 * An UNRECOGNIZED value THROWS rather than falling back. This is a deliberate
 * choice: the value is a build-time define, so a typo cannot be corrected at
 * runtime, and a silent fallback to `"http"` would ship a site that talks to a
 * commerce service the operator believed had been folded in — a failure that
 * looks like success.
 *
 * BE CLEAR ABOUT THE BLAST RADIUS. This does not surface as a failed request:
 * `manifest.ts` evaluates `resolveCommerceMode()` at MODULE LOAD to resolve
 * `ALLOWED_HOSTS`, so a bad define throws while the plugin module is being
 * imported and takes the WHOLE plugin down with it — every storefront route,
 * every sync hook and every admin screen, not just commerce. That is the
 * intended severity for a misconfigured build (the value can only be a typo
 * someone just introduced, and it is caught the first time anything imports the
 * plugin), but it is a boot failure, not a degraded one, and must not be
 * mistaken for a per-request error.
 */
export function resolveCommerceModeFrom(override: string | undefined): CommerceMode {
	if (override === undefined || override.length === 0) return COMMERCE_MODE_DEFAULT;
	if (override === "http" || override === "in-process") return override;
	throw new Error(
		`__OTTA_COMMERCE_MODE__ must be "http" or "in-process", received ${JSON.stringify(override)}`,
	);
}

/** The mode this bundle was built for. */
export function resolveCommerceMode(): CommerceMode {
	return resolveCommerceModeFrom(
		typeof __OTTA_COMMERCE_MODE__ === "string" ? __OTTA_COMMERCE_MODE__ : undefined,
	);
}
