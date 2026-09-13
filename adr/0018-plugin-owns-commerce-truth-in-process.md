# 0018. The plugin may own commerce truth in-process on `ctx.storage`

- Status: accepted
- Date: 2026-09-13
- Amends: **ADR-0006 Decision 2 only**, and within it only the clause forbidding **direct
  DB/storage access**. Every other prohibition in that decision stands, unamended. ADR-0006
  **Decision 1 — the workerd sandbox suites are the contract gate — is reaffirmed**, and
  becomes more load-bearing than before.
- Amends: **ADR-0014 Decision 5** — the stock, pinned-exact dependency floor and its no-fork,
  no-fork-build, no-patched-dependencies, no-overrides, no-vendored-copy clause — **for the
  duration of the vendored host build only**, described below.
- Refines: [ADR-0002](./0002-adapter-based-split.md) — the ports-and-adapters seams it designed
  are what make this possible, and nothing about them changes. This record does **not** answer
  ADR-0002's five "a service may remain" reasons and does not retire the service: that is
  **ADR-0020**'s job, and until it is written those reasons stand as written.
- Relates to: [ADR-0013](./0013-product-title-is-cms-owned.md) (unchanged by this record; see
  the closing note)
- Forward references: **ADR-0019** (the storage document model for commerce aggregates) and
  **ADR-0020** (one deployable) — both **to be written**.

## Context

[ADR-0002](./0002-adapter-based-split.md) established that the boundary between the plugin
and the commerce service is a **deployment choice** over stable ports: the domain owns the
rules, adapters own the IO, and where a port's implementation happens to run is not an
architectural fact. That design has been honoured. What it has not been used for is the one
move it most obviously enables — running the commerce implementation *inside the plugin*.

Two things stood in the way.

The first was a capability question, and it turned out not to exist. A plugin's `ctx.storage`
is a per-plugin document store the host builds on an **always-available** path: there is no
`storage` capability string in the host's vocabulary to grant, and the same is true of
`ctx.cron`. So owning commerce truth in-process needs no new grant and widens no declared
permission.

The second was our own lint rule. `plugin-is-sandbox-clean` forbade the plugin from importing
`@otta-sh/domain` at all. That ban was never a statement about knowledge; it was a **proxy for
"the plugin must not acquire IO"**, and the domain was a cheap thing to name because it is the
package most likely to grow an adapter import by accident. The proxy is now costing more than
it buys: it forbids precisely the composition ADR-0002 designed for, while the property it was
standing in for is enforced directly and on every commit by `domain-is-io-free` — the domain
has zero runtime dependencies and no `node:` imports anywhere in its sources.

There is also a host-version fact. The document store's **conditional-write primitives** —
guarded update, versioned read, revision-based compare-and-set, revision-based delete — are
what make a single-document write safe under concurrent writers, and therefore what make
commerce truth on `ctx.storage` correct rather than hopeful. They are not available in a
released host: one is merged upstream but **unreleased**, and the rest are an **open upstream
change**. Until a release carries them,
the repo binds a **locally built, vendored build of the host** that does.

## Decision

1. **The EmDash plugin may own commerce truth in-process, on `ctx.storage`.** The domain's
   use-cases may be constructed inside the plugin and bound to the store the host injects. The
   plugin remains the *transport* layer and the holder of `ctx`; it does not acquire rules of
   its own.
2. **`@otta-sh/domain` is admitted into the plugin's dependency perimeter.** It is IO-free by
   construction and separately enforced, so importing it cannot put IO inside the isolate.
3. **`@otta-sh/store-emdash` is the adapter package**: the stores, the structural
   `StorageAccess` port they are written against, and the in-process id and clock
   implementations. It is admitted into the plugin's perimeter on the same reasoning as the
   domain — it carries no IO of its own, because its storage implementation arrives injected.
4. **The capability posture does not change.** The descriptor's capabilities stay exactly the
   manifest's two. Nothing here adds a capability string, because there is none to add:
   `ctx.storage` and `ctx.cron` are ungated.

### What ADR-0006 keeps

Decision 2's other prohibitions all stand: no React admin components in the standard-format
plugin, no `page:fragments`, no `options`-configured native format, nothing that works only in
trusted mode.

**"Zero EmDash dependency" also stands — for the plugin package.** It has no dependency on the
host, in either manifest section, and none of its sources import host code. What makes that
survivable is that `ctx` is *injected*: owning commerce truth needs the storage object, not the
host's implementation of it.

For `@otta-sh/store-emdash` the same claim **narrows, deliberately, to "zero EmDash *runtime*
dependency"**. The structural port is written in terms of the host's own storage types via
`import type`, so the adapter names the host's types and never executes the host's code. A type
import emits nothing, so it cannot put host behaviour inside the isolate; a runtime import of
the same module would, and fails the build. This allowance is not an oversight to be tidied
later: hand-mirroring those types would buy no safety and guarantee drift. It is held to by a
dedicated lint rule rather than by convention.

### ADR-0006 Decision 1 is reaffirmed — with an honest statement of what it proves

The workerd sandbox suites remain the contract gate. A change that only works with the plugin
registered trusted is still broken and must not merge. Commerce truth moving in-process makes
that gate *more* important, not less, because the storage code paths it will have to exercise
are where the money lives.

It is worth being exact about the gate's reach, because it is easy to overclaim:

- **Today the sandbox suites exercise the injected HTTP and key-value surfaces only.** The
  harness builds a plugin context with those two members; there is no `storage` on it, and
  existing suites assert its absence. So as of this record, no sandbox suite touches a
  storage code path — because there are none in the plugin yet.
- **This record therefore carries an obligation, not a claim.** The storage-backed sandbox
  suites **will inject a real storage repository** into the plugin's context, so that the
  plugin's storage code paths are exercised **under real workerd against the real storage
  implementation** — not a fake, not a reimplementation. They land with the increment that
  puts commerce truth on `ctx.storage`, and the gate is not satisfied until they do.
- **Injecting the repository is not the same as going through the host's sandbox bridge**, and
  the difference must not be blurred. The bridge is real, and it does wire all four
  conditional-write operations; **no Otta tier exercises it**, and none is planned to, because
  first-party deployments register the plugin trusted and nothing deployed depends on it.
- **The D1 tier is what observes the real host code**, and its reach is also worth stating
  exactly: it constructs the host's **real storage repository** over the host's **real
  migrations** and the host's **real D1 dialect**, built the way a deployed site builds it, and
  runs against the local simulator. It does **not** load the plugin, its context, or the
  bridge. So it answers "do the primitives behave on this dialect" rather than "does the host
  hand them to a sandboxed plugin correctly".

### The vendored host build, and why ADR-0014 Decision 5 is amended

ADR-0014 Decision 5 required the dependency floor to stay stock and pinned exact, with no fork,
no fork build, no patched dependencies, no overrides and no vendored copy. For the duration
described here, it does not.

**No published host release carries the conditional-write primitives.** Without them there is
no correct way to hold commerce truth in a document store — a read-then-write cannot be made
safe under concurrent writers — so the alternatives were to **wait for a release**, or to ship
a reference implementation of the primitives that would immediately drift from the real ones.
Waiting was rejected: the primitives exist as upstream code today, and the decision is not
blocked on anyone's release schedule.

So the repo binds a **locally built, vendored build of the host** carrying them. Three
properties keep this from becoming a fork in the sense Decision 5 forbade:

- It is a build of **upstream's own code** — a merge of released and unreleased upstream work
  plus the fix-up the merge itself made necessary. No Otta-authored behaviour is in it.
- The **package specifiers stay plain**. Only a workspace-level override redirects them to the
  vendored build, so adopting a real release is an **override edit**, not a migration.
- It is **explicitly temporary**, with its own record of what went into it and a script that
  rebuilds it, and it is removed once a release carries the primitives.

Decision 5's intent — that a host upgrade can never quietly break us — is served by the same
things it always was: the plugin's zero EmDash dependency, and the structural port that makes
swapping the binding a one-file change.

### The boundary, as rules

The decision is encoded in the repo's dependency rules, not left to review:

- **`domain-is-io-free`** is unchanged, and is this record's **premise**. Everything above rests
  on the domain having no IO; that is a build failure if it ever stops being true.
- **`plugin-is-sandbox-clean`** now **admits** `@otta-sh/domain` and `@otta-sh/store-emdash`,
  and still **forbids**: database drivers, query builders, the workerd package itself, HTTP and
  WebSocket client libraries, the filesystem/process/socket/vm builtins (in both the prefixed
  and unprefixed spellings), the commerce service, the payment adapter packages, the React
  admin console package, and **every other store adapter**. The store carve-out is written as
  a negative lookahead, so a store package added later is banned by default rather than by
  anyone remembering to add it, and it is mirrored into the bare-specifier spellings as well as
  the path spelling — a package imported without being declared never resolves to a path, so a
  clause written only in the path spelling silently permits it. **The payment adapters are
  still forbidden**, and enter the perimeter later by a **separate amendment of this same
  rule**, at the increment that ports payment signing to WebCrypto.
- **Three `store-emdash-*` rules** hold the adapter package to the same perimeter: one bans the
  React console dependencies across the whole package; one repeats the plugin's IO perimeter
  over its sources, **with no type-only exemption** — a type-only database-driver import is how
  a module starts being written against a host it must never touch; and one expresses the seam
  itself, permitting type-only imports of the host and failing any runtime import.
- **A new ban closes an inversion** nobody's rule caught: `@otta-sh/store-emdash` may not
  import `@otta-sh/plugin`. The plugin is what injects the store into the adapter, so an import
  in that direction would make the adapter depend on its own caller.

Every case these rules turn on is **executed** in the plugin's test suite, which cruises
the real config over planted imports and asserts the name of the rule each one trips. A rule
that silently stops matching fails there — which is not hypothetical: the builtin clause of
the plugin rule matched nothing at all for months because it was written in one spelling only.

## Consequences

**What becomes easier.** The commerce implementation can be composed where the data is, with
no network hop between a rule and the rows it guards, and no second deployable to keep in step.
The domain contract suites keep being the spec — they are what the new adapters are held to,
unchanged.

**What becomes harder, and what we accept.**

- **The plugin's bundle grows** by the domain and **one storage adapter** — and, once the
  payment adapters are admitted by their own amendment, by those too.
  This is accepted and will be **measured** rather than estimated; if the number is
  uncomfortable, the admin and reporting paths are the ones to load lazily.
- **The vendored build is a standing obligation**: it must track upstream if upstream moves,
  and it must be removed when a release makes it unnecessary. It is bounded, recorded and
  rebuildable, but it is real.
- **A conditional write can be contended.** Truth held in one document per aggregate means a
  hot aggregate retries. There is no structural fix; the retry depth is a **budget to be
  measured and asserted**, not a number to be hoped about. ADR-0019 records it.
- **The plugin's hand-mirrored wire types lose their reason to exist** once the HTTP transport
  is removed: they would then be either an unnecessary copy of domain types or, deliberately,
  the admin routes' response shapes. **That decision is deferred** to the increment that
  deletes the transport, and must be made explicitly there rather than by default.

**What is unchanged.** The declared capabilities, the descriptor format, the route-based
storefront shape of ADR-0003, and the trusted-registration posture of ADR-0006 Decision 1.
ADR-0002's ports-and-adapters discipline is not merely preserved — it is the thing being
spent, as designed.

**Note on the content-access gap.** [ADR-0013](./0013-product-title-is-cms-owned.md) records
that the host's content API offers no batch-by-id read and no search, which is why the title
projection exists. Moving commerce truth in-process **neither improves nor worsens that gap**;
it is out of scope here and remains unresolved.

**What would reopen this decision.** The domain acquiring IO (which the premise rule would
catch first); a measured bundle or contention figure that no lazy-loading or document-model
change can bring back inside budget; or the conditional-write primitives failing to reach a
released host at all — in which case the binding, not the boundary, is what is reconsidered.
