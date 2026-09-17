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
 *    (`settings:x402FacilitatorSecret`, INC-C3), because it is a secret. NOTE
 *    that in-process this key holds the facilitator's BEARER API CREDENTIAL,
 *    which goes on the wire — not INC-C3's offline HMAC secret, which never did.
 *    `payment-secrets.ts` documents the change at the key itself, and the
 *    Settings field is labelled for the new meaning;
 *  - **`payTo` and the accepted networks** are READABLE kv, because they are
 *    ordinary non-secret configuration an operator must be able to read back into
 *    a form — exactly the split `payment-secrets.ts` records for the service's
 *    non-secret companions (`X402_PAYTO`, `X402_ACCEPTS`).
 *
 * WHY `payTo` IS KV AND NOT A BUILD-TIME DEFINE (INC-C5 review, A4 — recorded
 * because it is a real trade-off, not an oversight). The reviewer is right that
 * `types.ts` reserves `ctx.kv` for "cosmetic, display-only prefs … never for
 * anything the domain depends on", and `payTo` is the buyer's payment
 * destination. It stays in kv anyway, for one reason the alternative cannot
 * meet: `facilitatorUrl` HAS to be a define because `ALLOWED_HOSTS` is derived
 * from it at module load, but `payTo` grants no egress and constrains nothing at
 * build time — making it a define would mean a treasury-wallet rotation requires
 * a plugin rebuild and redeploy, and would leave an operator with NO reachable
 * way to configure x402 at all (which is the other half of the same review).
 * What the tier costs is mitigated at BOTH ends instead: the value is shape-gated
 * on read ({@link isPlausiblePayTo} — a value that cannot be an address arms no
 * gateway) and on write (the Settings form refuses the save and says why), so a
 * lost last-writer-wins race or a typo degrades to a loud, legible refusal
 * rather than to misdirected funds. The residual risk — two operators racing
 * with two DIFFERENT well-formed wallets — is a change-control question, not one
 * a CAS would answer.
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
	if (payTo === undefined || !isPlausiblePayTo(payTo)) return undefined;
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

/** A bare EVM account (`0x` + 20 hex bytes), the address family every network in
 *  {@link DEFAULT_X402_ACCEPTS} uses. Case-insensitive: EIP-55 checksumming is
 *  mixed-case by design, and this gate must not reject a correctly checksummed
 *  address. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The same account written as CAIP-10 (`<namespace>:<reference>:<address>`) —
 *  the exact shape the CAIP-2 network ids in `accepts` already use. */
const CAIP10_EVM_ACCOUNT = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:0x[0-9a-fA-F]{40}$/;

/**
 * Could this string be the wallet the buyer's money goes to?
 *
 * WHY THIS GATE EXISTS (INC-C5 review, A4). `payTo` is READABLE kv, a tier
 * `types.ts` describes as last-writer-wins with no CAS and reserves for values
 * "the domain never depends on". This one it depends on completely: the value
 * goes straight into the `x402_challenge` the buyer pays. A `readPlainSetting`
 * that validated nothing beyond "non-empty string" meant a fat-fingered save
 * produced live challenges payable to a typo, and the only symptom would have
 * been money that never arrived.
 *
 * FAIL-CLOSED, and CONSERVATIVE ON PURPOSE. Anything this does not recognise
 * yields NO gateway, which the domain reports as "this payment method is not
 * available" — the same loud refusal an unset `payTo` gets. A deployment on a
 * non-EVM chain family therefore needs a line added here, deliberately: widening
 * the fund destination is exactly the kind of change that should cost a code
 * review rather than happening by accident in a settings form.
 *
 * NOT NORMALISED. The value is passed through byte-for-byte. Rewriting a payment
 * destination (lowercasing a checksummed address, stripping a CAIP-10 prefix)
 * would be a worse bug than refusing one.
 */
export function isPlausiblePayTo(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed !== value) return false;
	return EVM_ADDRESS.test(value) || CAIP10_EVM_ACCOUNT.test(value);
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
