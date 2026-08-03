---
"@otta-sh/plugin": patch
"@otta-sh/admin-react": patch
---

Retire the block-tree half of the console transport (ADR-0015 Decision 1,
INC-R4).

Both console screens now dispatch to structured actions that RETURN an outcome,
so nothing drives a Block Kit page handler and nothing scrapes a rendered block
tree. ADR-0015 put the removal of the forwarding machinery in its own change
once no caller remained; this is that change.

- **Removed from `admin/console-transport.ts`:** `forwardConsoleAct` (the
  forwarder), `forwardedFormSubmit` (the carrier mint), `firstNotice` (the banner
  scrape) and `nothingApplied` (the empty-tree refusal), together with the types
  that existed only to serve them — `ForwardedInteraction`, `ConsoleActPayload`
  and `ConsoleNotice` — and the `Block`, `RouteHandler`, `PluginContext`,
  `SandboxedRouteContext`, `encodeCarrier` and `CarriedContext` imports they were
  the only users of. Each was verified callerless across the packages and the
  site before deletion. None was re-exported from the package barrel, so no
  published entry point changes.
- **Kept, because both tiers must agree on them:** the two console interaction
  types and their set, the refusal shape, `UNREADABLE_REQUEST`, `UNKNOWN_ACTION`,
  `ConsolePayload` and `readConsolePayload`. `orders-console-route.ts` drops
  `ConsoleActPayload` from its import and its re-export block; nothing consumed
  it.

Vocabulary left pointing at things that no longer exist is cleared with it: the
two-descriptor sidebar gate is renamed from the console shell page it was
originally written on to what it now asserts, and the comments that counted the
Block Kit screens as seven or six now say five, which is what the descriptor
declares and what the site's own pin asserts.
