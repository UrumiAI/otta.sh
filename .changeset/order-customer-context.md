---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Surface the customer behind an order on the admin order detail (admin-UX Increment 1,
"customer context" slice). Read-only — no new writes, no migration: the slice surfaces
data the domain already holds (`orders.customer_id`/`buyer_ref`, `customers`, `addresses`,
`customer_sessions`).

The core design decision is the **union customer key**. Orders are born
`customer_id = NULL` and only back-linked at the customer's NEXT magic-link login
(`linkGuestOrders`), so on the common path one person owns both linked and
not-yet-relinked orders. Keying on either column alone undercounts or mislabels; the
customer dimension is therefore `customer_id = :id OR lower(buyer_ref) = lower(:email)` —
safe because `linkGuestOrders` already treats that email match as ownership proof.

- **Domain (`[Domain]`).** `OrderListFilter` gains a `customer?: OrderCustomerKey` union
  dimension (ANDed with states/window/search); new `OrderStore.countOrders(filter)` shares
  ONE predicate with `listOrders` so a count can never disagree with the list it captions.
  New token-free `SessionStore.listForCustomer → SessionSummary[]` (id/created/expires/
  revoked — never a token or hash). New pure use-case `getOrderCustomerContext`: resolves
  the account via `customer_id` → guarded `getByEmail(buyerRef)` fallback (buyer_ref is a
  claim token, not guaranteed email-shaped), labels the link honestly
  (`claimed`/`unclaimed`/`guest`), and aggregates addresses, sessions, order count, and
  recent orders (excluding the viewed order, capped) under the union key — identical
  context from ANY of the person's orders.
- **Adapters (`[Adapters]`).** One shared `orderFilterConditions` builder feeds both
  `listOrders` and `countOrders` (case-folding kept in sync structurally);
  `listForCustomer` never selects `token_hash`. Green against the extended contracts on
  better-sqlite3 and Postgres. No index exists yet on `orders.customer_id`/`buyer_ref`
  (pre-existing debt — tracked in the indices follow-up), so the new predicates seq-scan.
- **Service (`[Service]`).** `GET /admin/orders/:id/customer-context` mirrors the use-case
  1:1 under the internal-token guard (a read — the write gate does not apply). This is the
  first admin-surface routing of customer PII (email, address book, session metadata):
  token-gated, token-free on the wire, and never logged.
- **Plugin (`[Plugin]`).** The order detail gains a read-only "Customer" section: identity
  with honest linkage copy ("order not yet claimed" / "Guest — no account"), the profile
  address book behind a prominent "NOT the address this order shipped to" disclaimer
  (orders capture no shipping address), token-free session history, and the person's other
  recent orders. Fetched in parallel with notes; a failed read degrades to an explicit
  "unavailable" body — never a blank section, never a blanked detail page. Sandbox-clean.
