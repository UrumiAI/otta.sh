---
"@otta-sh/payments-x402": minor
---

Implement the `X402Rail` port (ADR-0028, increment 6 of 8). Nothing calls it yet: the domain
use case comes in increment 7, and the public routes in increment 8.

`createX402Rail({facilitatorUrl, facilitatorApiKey?, payTo, networks, fetch})` implements the
port for `exact` USDC on Base and Base Sepolia, EIP-3009 only, x402 v2 only.

- The USDC asset table is fixed in code (`X402_USDC_ASSETS`). A configured network outside it,
  a non-USD or zero price, a `payTo` that projects onto no network (or is the zero address),
  or a resource URL that is not absolute offers nothing.
- Cents map to atomic units as `BigInt(cents) * 10_000n`, and back only when exact.
- A CAIP-10 `payTo` is used only on its own network, compared as an exact string. Addresses
  compare as 20 bytes, so letter case never matters.
- The decoder refuses an oversize, v1, Permit2 or ERC-7710 payload, and any pinned format it
  does not meet, before any network call. The structural match also refuses another scheme,
  network, asset, `payTo`, recipient or token domain before any call.
- `facilitatorUrl` is the facilitator's base URL and must be `https:`. The adapter calls
  `{base}/verify` (10 s) and `{base}/settle` (30 s) through the injected `fetch`, and sends our
  own requirements. Bodies are read up to 16 KiB. A response that reports a different final
  URL is never trusted.
- It works with a real `Response` and with the plain `{status, headers, text()}` object that
  EmDash's Cloudflare Worker Loader bridge returns (no `url`, no `body`). It passes no
  `AbortSignal`, which cannot cross that bridge's RPC; its own timeout bounds every call.
- `verify` and `settle` refuse, with no call, a payment or offer that is not the very object
  `decode` or `offer` returned.
- `encodeX402Header` encodes a `PAYMENT-REQUIRED` or `PAYMENT-RESPONSE` value (UTF-8, then
  standard base64), the inverse of the decoder.
- The key, when set, is sent only as `Authorization: Bearer`, and never appears in a result.
  The adapter logs nothing.
- "Could not ask" is never "no". 401, 403, 408, 429, 3xx and 5xx, timeouts, transport errors
  and malformed bodies are unavailable (`/verify`) or unconfirmed (`/settle`). A `/settle`
  failure counts as `rejected` only with an allowlisted pre-broadcast reason and an empty
  transaction. Everything else is unconfirmed, for a manual check.
