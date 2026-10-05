---
"@otta-sh/domain": minor
---

`CreateOrderCommand` gains an optional `addressRequired` (issue #382). When `true`,
`createOrderFromCart` refuses a checkout with no shipping address as
`MISSING_SHIPPING_ADDRESS` for ANY cart — digital-only and no-zone carts included — at the
same point as ADR-0021's zoned-physical refusal, so nothing is minted or redeemed. A
same-key replay still short-circuits before the check. Absent or `false`, nothing changes.
