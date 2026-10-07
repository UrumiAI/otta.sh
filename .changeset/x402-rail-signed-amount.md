---
"@otta-sh/payments-x402": patch
"@otta-sh/domain": patch
---

The x402 rail now checks the signed amount itself. `verify` and `settle` refuse, with no
facilitator call (`offer_mismatch`), a payment whose signed `authorization.value` is not
exactly the offer's amount. Before, the adapter relied on the facilitator to compare them; one
that accepted an overpayment could have settled money for an order that is then refused. The
`X402Rail` port's docs say so.
