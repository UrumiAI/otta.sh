---
"@urumi/plugin": patch
---

Extract a reusable admin list/detail scaffold from the Orders console (admin-UX
Increment 0, slice 2). Behavior-preserving refactor — no wire change, no new
entity screens; the Orders page is ported onto the scaffold as the proof.

The `list → detail` dispatch pattern in `orders-page.ts` is generalized into
`packages/plugin/src/admin/scaffold/` so upcoming screens (product list, tax
classes, shipping zones → methods → rates) reuse it instead of re-deriving it.
Surface:

- `screenActions(entity)` — namespaced `<entity>:<verb>` action ids + the
  dispatcher's action-id set (the four nav verbs plus custom verbs).
- `createListDetailHandler({actions, createClient, levels, parseOpen,
  customActions})` with `listLevel(...)` / `leafLevel(...)` / `customAction(...)`
  — an N-LEVEL dispatch engine (open / back / page / apply-filter) driven by an
  array of levels indexed by drill depth. Designed for depth ≥ 3 (zones →
  methods → rates), not just 2; each level's `render` owns its own Block Kit body.
- `NavPath` + `encodeListCursor` / `decodeListCursor` + `backButton(...)` —
  drill-path & keyset-cursor plumbing that survives stateless interactions.
- `readAdminTokens(ctx)` — the one place admin + service tokens are threaded.
- `Notice` / `noticeBanner(...)` / `failClosedResponse(...)` — consistent banner
  and fail-closed rendering (em-dash's authoritative `{variant,title,description}`
  shape; never leaks a raw HTTP status/URL).

The scaffold is IO-free pure control flow (the only egress is the screen's own
`ctx.http` client), so it stays sandbox-clean. The Orders console renders and
behaves identically — its existing workerd-sandbox suite is the regression net,
and a new characterization suite drives a synthetic 3-level screen to exercise
pagination round-trip, drill-in dispatch, N-level back-navigation, and banner
rendering beyond what the 2-level Orders page can reach.
