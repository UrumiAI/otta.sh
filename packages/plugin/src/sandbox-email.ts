/**
 * The email provider the standalone workerd worker sends through — a seam
 * `sandbox-entry.ts` cannot fill for itself, exactly like `sandbox-storage.ts`.
 *
 * In a real deploy the host builds `ctx.email` over its own email pipeline;
 * neither this module nor `sandbox-entry.ts` is involved. The workerd suites
 * replace this module in the scratch tree they bundle with one that records each
 * message (`test/sandbox/harness.ts`, `email: true`).
 *
 * HERE IT IS ABSENT, which is EmDash's "no provider selected": the sandboxed
 * `ctx.email.send` then rejects "Email is not configured", as the host's own
 * sandbox bridge does (emdash 0.38).
 */

import type { EmailMessage } from "./types.js";

/** The provider for this bundle: none, unless something replaced this module. */
export function sandboxEmail(): ((message: EmailMessage) => Promise<void>) | undefined {
	return undefined;
}
