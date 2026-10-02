---
"@otta-sh/plugin": patch
---

An unknown Otta admin page (a bookmark to the retired Block Kit `/orders`, or a typo)
renders "Page not found" with a pointer to the sidebar instead of an empty screen.
Unrecognised actions keep answering with no blocks. Unknown paths under the React
`otta-console` descriptor are still rendered by the host ("Plugin responded with 404"),
because that descriptor has no route of its own by design (ADR-0014 D3).
