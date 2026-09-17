/**
 * The CHEAP OUTER GATE both public settlement routes run first.
 *
 * `webhooks/stripe/settle` (INC-C1b) introduced it; `entitlements/x402/settle`
 * (INC-C5 revision 2, review B2) needs exactly the same thing for exactly the
 * same reason, so it lives here rather than being copied — one gate, one set of
 * semantics, one place to get the constant-time comparison right.
 *
 * WHAT IT IS AND IS NOT. It is NOT the trust anchor of either route: a forged
 * Stripe webhook is stopped by the Stripe HMAC and a forged x402 receipt by the
 * facilitator, both verified unconditionally and neither switchable off by any
 * token. This is the layer in front of that — it lets a public route refuse an
 * UNATTRIBUTED request before it reads another kv key, builds a gateway, opens a
 * store, or (on the x402 route) spends a metered third-party facilitator call and
 * a Worker subrequest on a stranger's well-formed-but-bogus proof.
 *
 * PASS-THROUGH WHEN UNSET, mirroring `service/src/auth.ts`'s `requireServiceToken`
 * ("token unset ⇒ next()"): an un-provisioned deploy degrades to
 * "cryptographic anchor only", never to "nothing works" and never to
 * "nothing is checked".
 */
import {
	constantTimeEquals,
	WEBHOOK_EDGE_TOKEN_HEADER,
	webhookEdgeTokenFromKv,
} from "./payment-secrets.js";
import type { PluginContext, SandboxedRequest } from "./types.js";

/**
 * Case-insensitive header read, tolerant of BOTH container shapes.
 *
 * HTTP header names are case-insensitive, so matching `X-Otta-Wh-Token`
 * literally would fail the gate for a caller who sent `x-otta-wh-token`. That
 * half is load-bearing today. The CONTAINER sniffing below is DEFENSIVE: it
 * guards a dispatch path that does not currently exist, and no delivery has ever
 * been rejected for want of it. Before deleting that branch, check both triggers
 * that would make it live: the default export gaining a top-level `id` (a
 * `definePlugin`-style registration, which sends `adaptSandboxEntry` down its
 * pass-through branch), or this descriptor's `format` changing to `"native"` —
 * which the sibling `otta-console` descriptor in this same site already uses.
 *
 * What actually arrives, in either registration mode, is the plain lowercase
 * `Record<string, string>` that `SandboxedRequest` already declares. Otta
 * registers as `format: "standard"` and its default export (`plugin.ts`) has NO
 * top-level `id`, so EmDash's integration wraps the handler in
 * `adaptSandboxEntry` — and with no `id` on the definition that adapter takes
 * its non-pass-through branch and flattens `ctx.request.headers` into a record
 * before this handler is ever called. It does so for the in-process
 * registration (`plugins: []`, how `sites/staging` registers this plugin) just
 * as for the sandboxed one, so `PluginRouteHandler.invoke`'s genuine `Request`
 * never reaches here. The enumeration branch is the branch that runs.
 *
 * Why sniff anyway: a real `Headers` keeps its entries behind an iterator rather
 * than on the object, so `Object.entries()` on one returns `[]` and this gate
 * would silently read no header at all — degrading to "token set, header absent"
 * and a 401 on every genuine delivery. That failure mode is expensive enough,
 * and one `typeof …get === "function"` check cheap enough, that the annotation
 * is deliberately not trusted to be the last word on what arrives. `Headers` is
 * identified by its `.get`, which already does the case-insensitive match.
 */
export function header(request: SandboxedRequest, name: string): string | undefined {
	const headers = request.headers as unknown as
		| Record<string, string>
		| { get(name: string): string | null };
	if (typeof (headers as { get?: unknown }).get === "function") {
		const value = (headers as { get(name: string): string | null }).get(name);
		return value === null ? undefined : value;
	}
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers as Record<string, string>)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

/**
 * `true` when the request may proceed.
 *
 * Three outcomes, and the middle one is the subtle one:
 *  - token UNSET (never provisioned, empty, or kv unreadable — `readWriteOnlySecret`
 *    folds all three to `undefined`) ⇒ PASS THROUGH. The route's cryptographic
 *    anchor still applies.
 *  - token SET, header absent ⇒ reject. No comparison is attempted; the absence
 *    of a header is not a secret and leaks nothing by short-circuiting.
 *  - token SET, header present ⇒ CONSTANT-TIME compare (`constantTimeEquals`),
 *    never `===`, which returns at the first differing byte and would leak the
 *    token one character at a time through response latency.
 */
export async function edgeTokenAccepted(
	ctx: PluginContext,
	request: SandboxedRequest,
): Promise<boolean> {
	const expected = await webhookEdgeTokenFromKv(ctx);
	if (expected === undefined) return true;
	const provided = header(request, WEBHOOK_EDGE_TOKEN_HEADER);
	if (provided === undefined) return false;
	return constantTimeEquals(provided, expected);
}
