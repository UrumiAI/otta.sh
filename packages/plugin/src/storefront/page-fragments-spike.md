# Platform spike (Phase 2 §4.1 / §7 step 2.0) — verified finding

_Written before any Phase 2 red tests, per the plan's "first task" instruction. Mirrors how
`draft-plans/emdash-platform-notes.md` verified the sandbox/storage constraints — this note
does the same for `page:fragments`. File paths below are relative to the EmDash repo root
(`~/em-dash`), commit as checked out at spike time._

## Question the plan left open

Plan §4.1: does `page:fragments` let the plugin inject PDP/PLP price/availability + JSON-LD
fragments into EmDash-native content pages, or must PDP/PLP become plugin-owned routes?
`emdash-platform-notes.md` had only recorded "`page:fragments` injects script/style/JSON-LD
into public pages" without checking who is allowed to register it.

## Verified finding: `page:fragments` is trusted-plugin-only — Urumi cannot use it

Urumi's plugin is, and must remain, a **sandboxed** plugin
(`CLAUDE.md`: "Dev/test against the workerd-on-Node sandbox, not trusted in-process mode").
Source confirms sandboxed plugins are categorically excluded from `page:fragments`:

- `packages/core/src/plugins/types.ts:952` — the hook is commented
  `// ── page:fragments (trusted-only) ──────────────────────────────`.
- `packages/core/src/page/fragments.ts:5` — doc comment: "Collects raw markup / script
  contributions from trusted plugins via the page:fragments hook. **Sandboxed plugins are
  never invoked.**"
- `packages/core/src/emdash-runtime.ts:3600-3638` (`doCollectPageContributions`) — trusted
  plugins run through `this.hooks.runPageFragments(...)`; the loop over
  `this.sandboxedPlugins` immediately below is annotated
  `// Sandboxed plugins — metadata only, never fragments` and only ever calls
  `plugin.invokeHook("page:metadata", ...)` — there is no code path that reaches a sandboxed
  plugin's `page:fragments` handler, even if one were declared.
- `packages/core/src/plugins/manifest-schema.ts` + `packages/plugin-cli/src/bundle/api.ts:226-230`
  — bundling a plugin that declares `hooks["page:fragments"]` emits a hard warning: "Plugin
  declares page:fragments hook — this is trusted-only and will not work in sandboxed mode."
- `skills/creating-plugins/references/hooks.md:412-414` — authoritative doc text: "**Trusted
  plugins only.** Sandboxed plugins cannot register this hook — the manifest schema rejects
  it."

Additionally, even where sandboxed plugins *are* invoked (`page:metadata`), the only
contribution kinds available are `meta` / `property` / `link` / `jsonld`
(`packages/core/src/plugins/types.ts:933-941`) — no `html` body-content kind. So there is no
sandboxed-plugin-reachable hook that can inject a price/availability/purchasability fragment
into an EmDash-native page body, and no other public-page hook available to a sandboxed
plugin that could substitute.

(Aside: `page:metadata`'s `jsonld` contribution kind is available to sandboxed plugins, so
if PDP/PLP ever *did* stay EmDash-native for markup, Product/Offer JSON-LD specifically could
still ride `page:metadata` — but that doesn't rescue the plan's fragment-injection design,
which also needs a rendered price/stock/"not purchasable" body fragment, which `page:metadata`
cannot express.)

## Conclusion — ADR-triggering

**PDP/PLP must be plugin-owned public routes, not `page:fragments` injection into
EmDash-native content pages.** This breaks the platform-shape assumption in plan §4.1/§4.2
("the product content page and the listing page are EmDash-native pages ... the plugin's job
is to inject fragments"). Per the plan's own §4.1 fallback note, this does **not** affect the
join/loader/JSON-LD/`formatMoney` utilities (§4.2–§4.4, §6, §7 steps 1–8) — they are
transport-agnostic pure functions/services. Only the outermost PDP/PLP wiring (step 9/10)
changes shape, from a `page:fragments` handler to a plugin route handler (the same
`routes: { ... }` mechanism Phase 1 already uses for the admin routes
(`packages/plugin/src/plugin.ts`), with `public: true` — precedented by
`draft-plans/emdash-platform-notes.md`: "Routes: `POST /_emdash/api/plugins/{slug}/{route}`
... `public: true` for unauth/webhook routes" — and the pattern Phase 3 was already going to
need for cart/checkout routes, per plan §4.1 risk #2's own recommended resolution).

Per the task's pre-approved decision (1)+(2): this finding triggers the "ADR needed" branch.
**Implementation stops here pending an ADR decision** — ADR not drafted by this task; the
route-shape consequences (route naming, HTML vs. JSON response shape at
`/_emdash/api/plugins/{slug}/{route}`, how `page:metadata` JSON-LD combines with a
plugin-served page body, whether GET-style content pages are even reachable through the
`POST /_emdash/api/plugins/...` route dispatch observed at
`packages/core/src/emdash-runtime.ts:3249-3291`) are exactly the kind of systemic,
cross-phase decision `CLAUDE.md` requires an ADR for, not something to resolve unilaterally
mid-implementation.
