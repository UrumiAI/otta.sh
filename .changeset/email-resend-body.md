---
"@otta-sh/plugin": minor
---

Transactional email (magic-link sign-in, order emails) can reach real inboxes through
Resend, the documented provider (DEPLOYMENT.md, "Email provider").

- **The request body is Resend's `POST /emails`, exactly.** The template name used to ride
  as a top-level `template` string; Resend defines `template` as a hosted-template object
  that cannot be combined with `html`/`text`, so every send would have been refused. The
  name now travels as a tag, `tags: [{ name: "template", value }]`. **Compatibility:** an
  `EMAIL_API_URL` pointed at a custom endpoint that read `template` must read the tag
  instead; other providers need their own adapter behind the `EmailSender` port.
- **A refused send says why.** The thrown error carries the provider's own error `name` and
  `message` from a JSON body (parsed from at most the first 4096 characters), with control
  characters (C0, C1, DEL, U+2028/2029) turned into spaces, the recipient redacted case-insensitively, and the result bounded to 200
  characters. Nothing of the request (the sign-in link, the key) is included, and a non-JSON
  body adds nothing. Resend's testing-mode refusal quotes the account owner's address, which
  can therefore appear in the login route's log. Order-email refusals are not logged yet.
- **The Settings save refuses a from-address no provider will send from** — malformed, a
  control character anywhere, an unquoted `,` `;` or `"` in the display name, a `,` or `;`
  in the local part, an IP-literal
  or single-label domain, a label with a leading or trailing hyphen, a non-alphabetic TLD,
  or a reserved name (`.local`, `.localhost`, `.test`, `.example`, `.invalid`, `.internal`,
  `.onion`, `.alt`, `example.com/.net/.org`, `home.arpa`) — all-or-nothing like the payTo
  and sign-in link checks. `addr@domain` and `Name <addr@domain>` are both accepted; an
  internationalized domain is entered in its `xn--` form; empty is still allowed. The
  field's placeholder (previously the refused `no-reply@otta.local`) is now a deliverable
  example. The runtime default is unchanged and documented as dev-only. A stored
  undeliverable from-address is still sent with, and logged once per isolate.
  **Compatibility:** a from-address saved before this release that the new check refuses
  (e.g. a reserved domain, an unquoted comma in the name, an IP literal or a Unicode
  domain) must be fixed or cleared before the payment settings form will save again.
