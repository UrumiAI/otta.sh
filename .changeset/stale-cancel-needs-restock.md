---
"@otta-sh/plugin": patch
---

A Cancel posted for a paid, processing or later order without a Return to stock choice — from
an admin tab opened before the box existed — is now refused with "Nothing was cancelled — this
page is out of date … Reload the order and cancel again", and nothing is refunded or restocked.
It used to be read as ticked, so a stale tab's Cancel refunded and restocked without the
operator being asked (issue #364). A pending order's cancel still needs no choice: its held
stock is released either way.
