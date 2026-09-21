---
"@otta-sh/store-emdash": minor
---

The identity tier — customers with their address book embedded, hash-keyed sessions,
and magic-link challenges whose throttle is a claim document rather than a race.

`EmdashCustomerStore`, `EmdashAddressStore`, `EmdashSessionStore` and
`EmdashCredentialVerifier` implement their four ports in full against the domain's own
contract suites, on SQLite, Postgres and D1. Five documents carry what four tables and
no transaction used to:

- **One customer document holds the account and its addresses.** The `customers.email`
  UNIQUE constraint becomes `customer_emails/{emailLower}`, claimed before any customer
  document is written and re-asserted immediately before that write. A crowd of
  registrations for one address leaves one account, one claim and nothing from the
  losers. The claim carries an abandon window, because a holder a moment from writing
  its account and a holder that crashed are the same document — without one, a peer that
  read the claim in between produced a second account on one address. It is also the fast
  path and not the definition of existence: a lookup that does not resolve queries the
  indexed fold and writes the claim back.
- **A customer document can exist without a customer.** The address table had no foreign
  key and the port's own suite relies on it, so an address book for an unregistered id is
  a document with no email — invisible to every customer read, adopted rather than
  overwritten by a later registration, and deleted with its last address.
- **Cross-customer isolation is now a written check.** `WHERE id = :addressId AND
  customer_id = :customerId` has no equivalent once the addresses are embedded, so every
  address write proves the address is in the caller's own document, on the read the write
  is guarded on. A foreign address id is a miss, never another customer's row.
- **Sessions are keyed by the hash of their token.** The hash is the document id, so
  uniqueness is the primary key and no plaintext is stored anywhere. The history rows
  carry a separate session id, so an admin surface can name a session without ever
  holding one.
- **The magic-link throttle is exact under concurrency.** The SQL counted active
  challenges and then inserted, in two statements over a table with no constraint. Here
  the window is a claim document holding the slots currently taken, added to by a
  compare-and-set on the value they were counted from. A slot is taken before the
  challenge is written and released after the consume commits, so every residual is an
  over-refusal that lapses at the challenge's own expiry — no sweeper.
