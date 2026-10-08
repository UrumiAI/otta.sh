# 0033. The order number is a display prefix of the id, not a key

- Status: accepted
- Date: 2026-10-08

## Context

An order's identity is a UUID. The admin console showed a short, git-style prefix of it;
shoppers saw no identifier at all — only "Otta Tee and 2 more" (`orderLabel`). Two orders
of the same product therefore read alike in an inbox, and a shopper writing to the
merchant had nothing to quote that the merchant could search for.

Order ids are minted by `uuidIdGen` (`crypto.randomUUID()`, UUID version 4), so their
leading characters are uniformly random hex. (Had they been time-ordered — UUIDv7 — a
prefix would have been nearly the same for every order of the hour and useless as a label.)

Options considered: a sequential number (needs a counter document, a migration and a
contended write on every checkout — the one hot path ADR-0019 keeps to one document); a
longer random suffix stored on the order (a schema change for a display concern); a
prefix of the existing id (no storage, no migration).

## Decision

The order number is `"#"` + the first **5** characters of the order id, upper-cased —
`orderNumber(orderId)` in `@otta-sh/domain`, the one function every surface uses: the
order page, the account order list and detail, every order email (subject and body), and
the admin console (list rows and detail, sent on the admin wire as `orderNumber`).

- It is **derived on read and never stored**. The order id and the storage format are
  unchanged; there is no migration.
- It is a **display label, never a lookup key**. Nothing resolves an order by its number
  alone. URLs, Stripe metadata, idempotency keys and the outbox keep the full id.
- The admin search accepts it as typed (`"#3F9A2"`): `orderNumberSearchText` strips the
  `#` and the store's existing anchored, case-folded id-prefix arm does the rest. It may
  answer **several** orders.

## Consequences

- **Collisions will happen.** Five hex characters are 16⁵ ≈ 1.05 M values; by the
  birthday bound two orders share a number with even odds after roughly 1,200 orders,
  and a store with 10,000 orders has dozens of shared pairs. Accepted, because the number
  only has to tell a shopper's *own* orders apart and give support a short search term:
  - the admin search returns every order with that prefix, and the operator confirms by
    buyer, date or total — never by the number alone;
  - a search by number that answers several orders says so ("#3F9A2 matches 2 orders —
    confirm the buyer, date and total") above the rows;
  - two rows sharing a number on one console page extend it, upper-cased, to their
    shortest-unique prefix (`#FEE1D1`, `#FEE1D2`), so no two rows read the same and each
    cell is itself a searchable number; the detail shows the full id beside the number;
  - the refund confirm keeps its 8-character prefix, now upper-cased so it visibly extends
    the number.
- A search spelled exactly `#` + hex is read as an order number, so a sku or email local
  part spelled that way is found by searching without the `#`.
- Changing the length later only changes a label; nothing stored depends on it. A
  merchant who needs gap-free sequential numbers (an invoicing requirement in some
  jurisdictions) needs a real counter — a separate decision, not a longer prefix.
