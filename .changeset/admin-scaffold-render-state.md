---
"@otta-sh/plugin": patch
---

Give the admin list/detail scaffold a RENDER-STATE channel, so a custom action can
re-render a level with more than a banner. Additive: every existing call site
compiles and behaves identically, and `notice` is untouched.

`CustomActionApi.showLeaf` / `showList` take a third argument — the screen's own
`renderState` — which the target level's `render` receives verbatim alongside
`notice`:

```ts
showLeaf(path, notice?, renderState?)
showList(path?, notice?, renderState?)
```

Why: a `notice` says WHAT HAPPENED, and nothing else. The spec's DA-3a refusal
(the record moved under the operator, or they typed `19,99` in an amount field)
must re-render **state 1** with the right group open and the operator's input
preserved, and a banner alone leaves the re-rendered level guessing at both — so
the group the banner points at rendered collapsed while an unrelated group carried
`default_open`, and the typed amount was gone. The one screen that needed more
re-implemented its leaf's whole read-and-render path to get it; six more screens
were about to copy that.

Shape and guarantees:

- `RenderState` is the ONE type parameter the scaffold does not erase (`Client` /
  `Filter` / `Summary` / `Detail` still are). It crosses from one closure (a custom
  action) to another (a level's `render`), so no local soundness argument can cover
  it — instead `createListDetailHandler<State>` is where a screen's levels and its
  custom actions are checked against each other. Nothing is `any`, and the value is
  never cast.
- It defaults to `never`, so a screen that declares no render state has no channel
  at all: a stray third argument is a compile error, not a value quietly arriving
  at a `render` that ignores it. A stateless level or custom action inside a
  stateful screen is still written exactly as before.
- WITHIN-REQUEST ONLY. The value is passed by reference into the same response;
  nothing is stored, serialized or echoed to the client, and the next interaction's
  `renderState` is `undefined` again. Whatever must survive the next click still
  rides in `button.value` or a form's `block_id` carrier, so every screen stays
  stateless.
- It carries STATE, not DATA: the engine still calls the level's own `load`, so a
  DA-3a re-render shows freshly-read figures rather than the action's known-stale
  copy.
- The engine reads no property of it, so a hostile value can only throw inside the
  screen's `render` — already inside the level's containment, which fails closed to
  that level's `onError`. `notFound` is deliberately not given it (a form prefilled
  for a record that no longer resolves is a lie).

Covered by a new workerd-sandbox suite (state reaches a leaf and a list, notice and
state compose, prefill digests still move with the values, omitting it renders
identically to a plain open, the next interaction sees none of it, a hostile value
fails closed) plus a `@ts-expect-error` type-test pinning both halves of the
per-screen typing.
