---
"@otta-sh/domain": minor
---

Add the `X402Rail` port (ADR-0028, increment 6 of 8): types only, no behaviour, and nothing
calls it yet. The domain use case that does comes in increment 7.

- `X402Rail` has `offer`, `decode`, `matchOffer`, `verify` and `settle`. The first three are
  pure; the last two do IO through the adapter and never throw.
- New result types: `X402OfferResult`, `X402DecodeResult`, `X402MatchResult`,
  `X402VerifyResult` and `X402SettleResult`, with the requirements, offer and decoded-payment
  shapes. The decoded payment carries the payment key, network, payer, nonce, the amount in
  exact `Cents`, and the time window as `bigint` seconds.
- The decoded payment's wire payload is an opaque type the domain cannot build.
- `verify` answers valid, invalid or unavailable. `settle` answers settled, rejected or
  unconfirmed, and `rejected` means proven pre-broadcast.
