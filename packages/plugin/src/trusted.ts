/**
 * The plugin for an IN-PROCESS registration (EmDash `plugins:`, a descriptor
 * whose `entrypoint` is `@urumi.ai/otta-plugin/trusted`): the same object as
 * `@urumi.ai/otta-plugin/plugin`'s default export, with `trustedHost` on, so every
 * Stripe request carries an `AbortSignal` and a timed-out one releases its
 * socket (issue #447). NEVER the entry of a `sandboxed:` registration: a signal
 * cannot cross the sandbox runner's RPC (`payments/trusted-host.ts`).
 *
 * A site that also registers a tax calculator writes its own entry instead:
 * `export default createOttaPlugin({ trustedHost: true, taxCalculator })`.
 */
import { createOttaPlugin } from "./plugin.js";

export default createOttaPlugin({ trustedHost: true });
