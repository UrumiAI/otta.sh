/**
 * The one corner of `cloudflare:workers` the d1 specs touch: the bindings object.
 * The runtime module exists only inside `workerd`, so the Node-side typecheck needs
 * this stand-in; it is declared as loosely as the specs' own use of it.
 */
declare module "cloudflare:workers" {
	export const env: Record<string, unknown>;
}
