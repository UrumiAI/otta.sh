/**
 * x402 settlement, in-process (INC-C5) — the plugin's replacement for
 * `service/src/x402-wiring.ts`.
 *
 * WHAT ACTUALLY CHANGED. The gateway does not: `X402PaymentGateway` is the same
 * adapter, `refundable` is still `false` (ADR-0008 — on-chain settlement is
 * irreversible and nothing here holds a signing wallet), and the challenge is
 * still the same `x402_challenge` descriptor. What changed is the FACILITATOR.
 * The service could only ever wire `createTestFacilitator` — an OFFLINE
 * shared-secret HMAC that its own comment calls not-production-safe, since any
 * holder of the secret can forge a settling proof — which is why it refused to
 * start without an explicit `X402_ALLOW_TEST_FACILITATOR=true`. In-process the
 * facilitator is `createHttpFacilitator`, a real call to a real facilitator, made
 * through `ctx.http.fetch` and gated by `allowedHosts`. The opt-in gate has
 * nothing left to guard, so it is gone: the offline facilitator is simply not
 * reachable from this path.
 *
 * THREE HOMES FOR THE CONFIG, one reason each:
 *  - the **facilitator URL** is a BUILD-TIME define (`__OTTA_X402_FACILITATOR_URL__`,
 *    surfaced as `IN_PROCESS_EGRESS_URLS.facilitatorUrl`), because `ALLOWED_HOSTS`
 *    is resolved from that same value at module load. Reading the URL from kv
 *    instead would let the gate and the caller disagree — and the disagreement
 *    would present as an unexplained refused fetch;
 *  - the **facilitator credential** is WRITE-ONLY kv
 *    (`settings:x402FacilitatorSecret`, INC-C3), because it is a secret;
 *  - **`payTo` and the accepted networks** are READABLE kv, because they are
 *    ordinary non-secret configuration an operator must be able to read back into
 *    a form — exactly the split `payment-secrets.ts` records for the service's
 *    non-secret companions (`X402_PAYTO`, `X402_ACCEPTS`).
 *
 * FAIL-CLOSED. Missing URL or missing `payTo` ⇒ NO GATEWAY. The domain refuses a
 * checkout whose method has no gateway, so an unconfigured deployment gets a loud
 * refusal rather than a silently unverified settlement; and a kv rejection is
 * swallowed to the same `undefined`, because an unreadable `payTo` is exactly as
 * unconfigured as an unset one.
 */
import { createHttpFacilitator, X402PaymentGateway } from "@otta-sh/payments-x402";
import { X402_FACILITATOR_SECRET_KEY, readWriteOnlySecret } from "../payment-secrets.js";
import type { PluginContext } from "../types.js";

/** `X402_PAYTO` — the destination wallet the challenge names. Non-secret. */
export const X402_PAYTO_KEY = "settings:x402PayTo";

/** `X402_ACCEPTS` — the CAIP-2 networks the challenge accepts, comma-separated
 *  exactly as the env var was. Non-secret. */
export const X402_ACCEPTS_KEY = "settings:x402Accepts";

/** The service's own `X402_ACCEPTS` default (`x402-wiring.ts`), carried over
 *  unchanged: Base mainnet. */
export const DEFAULT_X402_ACCEPTS = ["eip155:8453"] as const;

export interface WireX402Options {
	/** The host's gated egress — `ctx.http.fetch`. */
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	facilitatorUrl?: string | undefined;
	facilitatorApiKey?: string | undefined;
	payTo?: string | undefined;
	accepts?: readonly string[] | undefined;
}

/**
 * Build the gateway from already-resolved config — pure in everything but the
 * injected `fetch`, so both refusal arms are testable without a context.
 */
export function wireX402Gateway(options: WireX402Options): X402PaymentGateway | undefined {
	const { facilitatorUrl, payTo } = options;
	if (facilitatorUrl === undefined || facilitatorUrl.length === 0) return undefined;
	if (payTo === undefined || payTo.length === 0) return undefined;
	const accepts =
		options.accepts !== undefined && options.accepts.length > 0
			? [...options.accepts]
			: [...DEFAULT_X402_ACCEPTS];
	return new X402PaymentGateway({
		facilitator: createHttpFacilitator({
			fetch: options.fetch,
			url: facilitatorUrl,
			...(options.facilitatorApiKey !== undefined ? { apiKey: options.facilitatorApiKey } : {}),
		}),
		payTo,
		accepts,
	});
}

/** The deployment-supplied half — passed in rather than read from the manifest
 *  here, so the wiring stays testable without a bundler (the same seam
 *  `resolveAllowedHosts` already uses). */
export interface X402Egress {
	facilitatorUrl?: string | undefined;
}

/**
 * Resolve every configured value for a context and wire the gateway, or report
 * `undefined` for "x402 is not configured on this deployment".
 */
export async function x402GatewayFromCtx(
	ctx: PluginContext,
	egress: X402Egress,
): Promise<X402PaymentGateway | undefined> {
	const facilitatorUrl = egress.facilitatorUrl;
	if (facilitatorUrl === undefined || facilitatorUrl.length === 0) return undefined;
	const [facilitatorApiKey, payTo, accepts] = await Promise.all([
		readWriteOnlySecret(ctx, X402_FACILITATOR_SECRET_KEY),
		readPlainSetting(ctx, X402_PAYTO_KEY),
		readPlainSetting(ctx, X402_ACCEPTS_KEY),
	]);
	return wireX402Gateway({
		fetch: ctx.http.fetch,
		facilitatorUrl,
		...(facilitatorApiKey !== undefined ? { facilitatorApiKey } : {}),
		...(payTo !== undefined ? { payTo } : {}),
		...(accepts !== undefined ? { accepts: splitAccepts(accepts) } : {}),
	});
}

/** A non-secret `settings:*` value, or `undefined` for unset / empty / non-string
 *  / unreadable. Same three fail-closed folds as `readWriteOnlySecret`, minus its
 *  no-echo obligations (these values are not credentials). */
async function readPlainSetting(ctx: PluginContext, key: string): Promise<string | undefined> {
	try {
		const value = await ctx.kv.get<unknown>(key);
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** `X402_ACCEPTS`' own `.split(",")`, plus the trim the env var never needed and
 *  a hand-typed settings field certainly does. An all-blank list resolves to
 *  nothing, so the documented default applies rather than a challenge that
 *  accepts a network named `""`. */
function splitAccepts(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
