/**
 * Pure env parsing shared by both entries (D4): `index.ts` feeds it
 * `process.env`, `worker.ts` feeds it the per-event `env` binding. No IO, no
 * process access here — everything is passed in.
 */

export interface ServiceEnv {
	CART_HOLD_TTL_MS?: string | undefined;
	INTERNAL_API_TOKEN?: string | undefined;
	SERVICE_API_TOKEN?: string | undefined;
}

export interface ServiceConfig {
	/** Hold TTL in ms; undefined ⇒ the domain default (15 min) applies. */
	ttlMs: number | undefined;
	/** Shared secret for `/internal/*`; unset ⇒ those endpoints answer 503. */
	internalToken: string | undefined;
	/** Shared secret for the write gate; unset ⇒ fully open (today's behavior). */
	serviceToken: string | undefined;
}

/** Hold TTL (§5): default 15 min, configurable via CART_HOLD_TTL_MS. */
export function parseHoldTtlMs(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const ttlMs = Number(raw);
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
		throw new Error(`CART_HOLD_TTL_MS must be a positive number, got "${raw}"`);
	}
	return ttlMs;
}

/** Resolve the service's env-derived config. Tokens pass through verbatim —
 *  the enforcement layers decide what unset/empty means (never silently open
 *  for `/internal/*`; open-by-default for the write gate, preserved behavior). */
export function resolveServiceConfig(env: ServiceEnv): ServiceConfig {
	return {
		ttlMs: parseHoldTtlMs(env.CART_HOLD_TTL_MS),
		internalToken: env.INTERNAL_API_TOKEN,
		serviceToken: env.SERVICE_API_TOKEN,
	};
}

/**
 * Shared open-write-gate warning builder (#42). Returns the warning message
 * when the `SERVICE_API_TOKEN` write gate is OPEN (token unset OR empty), and
 * `undefined` when a token is set. Both entries call it: the Worker fires it
 * once per isolate (worker.ts's `warnedOpenGate` flag), the Node bin once at
 * boot (index.ts). Each passes its own remedy string (wrangler vs env).
 *
 * CANONICAL CONDITION: the `undefined || length === 0` test here MUST match
 * `requireServiceToken` in src/auth.ts — that middleware is the source of
 * truth for what "the gate is open" means (it passes through on exactly this
 * condition). Keep the two in lockstep so the warning can never claim the gate
 * is open while the middleware enforces it, or vice versa.
 */
export function openWriteGateWarning(
	serviceToken: string | undefined,
	remedy: string,
): string | undefined {
	if (serviceToken !== undefined && serviceToken.length > 0) return undefined;
	return `[service] SERVICE_API_TOKEN is unset — the write surface is OPEN. ${remedy}`;
}
