/**
 * Test stand-in for `virtual:emdash/env` — the EmDash integration's virtual
 * module that re-exports Cloudflare's `env` (Worker bindings and secrets) under
 * `@astrojs/cloudflare`, and `undefined` under any other adapter.
 *
 * WHY A STUB AND NOT A `vi.mock`. The real module only exists once EmDash's
 * Astro integration has run; `vitest.config.ts` deliberately loads no Astro
 * config (`configFile: false`), so nothing generates it and the specifier would
 * not resolve at all. An alias in `vitest.config.ts` points the specifier here
 * instead, which keeps `src/lib/webhook-env.ts` — the ONLY module that touches
 * the specifier — real code under test rather than a mock.
 *
 * MUTABLE ON PURPOSE: a suite sets and deletes keys on this object between
 * cases, exactly as a deploy would have a secret provisioned or not.
 */
export const env: Record<string, unknown> = {};
