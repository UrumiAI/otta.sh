/**
 * Whether this plugin runs IN-PROCESS on its host (EmDash `plugins:`), as the
 * site said in its own entry module: `createOttaPlugin({ trustedHost: true })`
 * (issue #447, from #409).
 *
 * WHAT IT CHANGES. Two things. (1) How a Stripe call is bounded. On a trusted host every
 * Stripe request carries an `AbortSignal`, aborted when the call's own bound
 * passes, so a timed-out request's socket is released (on Node it would
 * otherwise be held until undici's own ~300 s timeouts). Results never change:
 * the call gives up at the same bound with the same class either way
 * (`@urumi.ai/otta-payments-stripe` `deadline.ts`). (2) Issue #497: whether the
 * plugin's own `process.env` is the host's, so Settings can warn up front about
 * a missing or malformed EMDASH_ENCRYPTION_KEY (`encryption-key-status.ts`).
 * Under the sandbox it is not, and no warning is shown.
 *
 * WHY THE SITE SAYS SO. The plugin cannot detect it: staging's trusted mode is
 * workerd, the same runtime as EmDash's sandbox runner, and under that runner a
 * signal in `init` either fails every call (0.38's RPC refuses to clone it) or
 * is dropped (1.0.1). So the default is `false`, and the sandbox entry — which
 * loads the default export — can never turn it on.
 *
 * PROCESS-WIDE AND STICKY. One module slot per isolate: the last
 * `createOttaPlugin({ trustedHost })` wins and nothing resets it. Never load the
 * trusted entry in the same isolate as a registration that must keep sandbox
 * semantics.
 */

let trusted = false;

/** Set from `createOttaPlugin`. Only the literal `true` opts in. */
export function setTrustedHost(value: unknown): void {
	trusted = value === true;
}

/** Read by every Stripe call site the plugin wires, and by
 *  `encryptionKeyStatus` (#497). */
export function isTrustedHost(): boolean {
	return trusted;
}
