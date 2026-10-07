---
"@otta-sh/payments-stripe": minor
"@otta-sh/payments-x402": minor
"@otta-sh/domain": minor
---

The two payment adapters HMAC with WebCrypto instead of `node:crypto`, so they can be
loaded inside the workerd sandbox (fold-in INC-C1). Both packages are constructed
in-process by the plugin, and the plugin's sandbox-clean rule bans `node:` imports — but
`payments-stripe` and `payments-x402` each opened with `import { createHmac,
timingSafeEqual } from "node:crypto"`, which is unavailable in the isolate. This is a
pure crypto-primitive swap: both packages stay in the repo, nothing is deprecated, and
the hand-rolled form-encoded HTTP client and the Stripe `Idempotency-Key` header are
untouched.

- **`crypto.subtle.verify`, not sign-then-compare.** Both packages verified a signature
  by computing the expected HMAC and running the result through `timingSafeEqual`. The
  replacement does not reimplement that comparison — it hands the candidate signature to
  the keyed HMAC *verify* primitive, which is constant-time by construction. That is
  strictly better than porting the old shape: there is no hand-rolled compare left to
  get wrong, and a timing side-channel on webhook signature verification cannot be
  reintroduced by a later edit that "simplifies" an XOR-accumulate loop into `===`.
  Signing (`crypto.subtle.sign`) is used only where a signature is MINTED — the offline
  fake-Stripe driver and the offline x402 facilitator's proof minter.
- **Hex decoding got stricter, and the observable result did not change.**
  `Buffer.from(s, "hex")` truncated silently at the first bad pair; the truncated buffer
  then failed `timingSafeEqual`'s length check and was caught as `false`. The new
  `fromHex` rejects odd-length and non-hex input up front and returns the same `false`.
  Upper-case hex is still accepted, as `Buffer.from` accepted it. Stripe's multi-`v1`
  secret-rotation header, the freshness window, and every rejection reason are unchanged.
- **`Buffer` went with it.** The Node `Buffer` global was used only on the crypto paths
  (`Buffer.concat` for the `{t}.{rawBody}` signed payload, `.toString("utf8")` before
  `JSON.parse`); those are now `Uint8Array` set-splicing and `TextDecoder`. The
  acceptance criterion was "no `node:` import remains", not "no `node:crypto`".
- **Two exported signers became async**, which is the one call-shape change in this
  work: `signStripeWebhook` and `signX402Proof` return a `Promise` because
  `crypto.subtle.sign` does, where `createHmac().digest()` was synchronous. Their output
  bytes are identical. `createTestFacilitator` is unchanged — its `verifyReceipt` was
  already async, which is why the x402 gateway's own port surface needed no edit at all.
  Both `PaymentGateway` implementations' `verifyConfirmation` were already async, so the
  SHIPPED port surface is byte-identical.
- **`@otta-sh/domain`'s gateway test harness widened its minter** to
  `RawConfirmation | Promise<RawConfirmation>` (the new exported `MintedConfirmation`),
  and `paymentGatewayContract` awaits at the five mint call sites. This is what let the
  contract's own CASES stay byte-identical through the port — every `expect`, every test
  name and every input is unchanged, which is the proof that the swap is
  behaviour-neutral rather than a spec that was adjusted to fit new behaviour. A
  synchronous minter still satisfies the type, so no other harness changed.
- **A guard test per package now bans the whole `node:` namespace**, in both spellings
  (`node:fs` and the bare `fs` that dependency-cruiser reports). It is the grep half of
  the same two-part mechanism `@otta-sh/plugin` already uses, deliberately rather than a
  new one — and it exists because the `plugin-is-sandbox-clean` depcruise rule
  enumerates specific IO builtins (`fs`, `child_process`, `net`, `http`, …) and does not
  name `crypto`, so the import this change removed would have cruised clean forever.
  Each guard also asserts it is not vacuous and that its matcher actually fires on a
  planted import.

`crypto.subtle` is an ambient global in both Node ≥19 and workerd, so no polyfill and no
new dependency. The full `payment-gateway-contract` suite is green against both adapters
before and after, and the entitlement-gated download test — which drives the real
workerd-on-Node sandbox through a signed Stripe webhook — passes with the WebCrypto
signer. No wire, schema, or migration change.
