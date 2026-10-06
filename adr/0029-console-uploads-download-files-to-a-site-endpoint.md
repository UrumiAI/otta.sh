# 0029. The console uploads a download file to one site endpoint

- Status: accepted
- Date: 2026-10-06
- Amends: [ADR-0014](./0014-second-native-descriptor-for-react-admin.md) **Decision 3 only**,
  and within it only the clause "It gets no new data path": the console may make **one**
  second request, the upload of a digital product's file to the site. Everything else in
  Decision 3 stands: `otta-console` still declares zero capabilities and zero `allowedHosts`,
  owns no hooks and no routes, and every read and every write of commerce data still goes
  through the existing `otta` admin route.
- Relates to: [ADR-0006](./0006-trusted-in-process-deployment.md) (its CSRF section: every
  site write route runs the origin guard first; PR #390 proposes moving that guard into the
  site middleware, default-deny),
  [ADR-0011](./0011-entitlement-check-authentication.md) (its 2026-10-05 amendment: the
  download gate), issue #376 part 1.

## Context

Paid downloads (issue #376) store their bytes in a private R2 bucket bound to the site as
`DOWNLOADS`, apart from EmDash's media bucket, which serves every key publicly. The plugin
owns the pointer (`downloadAsset` on `product_commerce`) and decides who may download; the
site streams the bytes. Increments 1–3 built all of that, so a merchant could sell a file
only after putting it in the bucket by hand and writing the pointer into storage.

Attaching a file from the admin needs something to carry the bytes into the bucket, and only
the site can:

- The plugin cannot. Its capabilities are `content:read` and `network:request`, R2 is a
  binding rather than a host, and a plugin route receives a parsed JSON body, not a byte
  stream.
- The console cannot either, by ADR-0014 Decision 3. It reaches commerce **only** through the
  `otta` admin route, and `console-api.ts` says there is no second fetch in the package and
  must never be one.
- EmDash's media upload is public by design, which is exactly what a paid file must avoid.

So the upload needs a site endpoint, and the console has to call it: one request ADR-0014
forbids.

## Decision

1. **The console makes one second request: `POST /otta-admin/downloads/{productId}` on the
   site, carrying the file's raw bytes.** It is sent from the product editor's Download file
   card, same-origin, with the operator's own session and `X-EmDash-Request: 1`. It reads no
   commerce data and writes none. It answers a descriptor, `{key, filename, contentType,
   size}`.
2. **The descriptor is saved through the `otta` admin route as before**, with a new
   console write, `products:attach-download`. The domain validates the descriptor there,
   exactly as for any other edit. The site endpoint never writes the product, so the plugin
   stays the only writer of commerce truth, and the descriptor's save is the one moment a
   product's file changes.
3. **The endpoint stores, and only stores.** It requires an EmDash session whose role holds
   `plugins:manage`: the role the admin route requires, so nobody can upload what they could
   not then attach. It resolves the product through the plugin's own admin read, with that
   user as the caller, and refuses a physical, trashed or unknown product. The key is
   `dl/{productId}/{ULID}`, minted by the server from the clock and fresh randomness, and is
   never derived from the filename or any request input. The declared type goes through the
   allowlist increment 1 validates (anything else is `application/octet-stream`). The
   filename is sanitized to a name, never a path. The body is streamed, not buffered, and is
   capped at 100,000,000 bytes, below Cloudflare's 100 MB request limit on the Free and Pro
   plans. The coercions live in `@otta-sh/domain` beside the validator, so whatever the
   endpoint produces, the save accepts.
4. **The endpoint is a storefront path, so it guards its own origin, first.** It is not
   under `/_emdash`, which EmDash guards itself. Like every other site write route it calls
   `rejectCrossOrigin` (ADR-0006's CSRF section) before it trusts the session or reads a
   byte, and it also requires `X-EmDash-Request: 1`, which a cross-site form cannot send. If
   the origin check moves into the site middleware (PR #390, default-deny), the route is
   guarded there automatically and is listed in that table's GUARDED column — never the
   exempt one — by whichever of the two changes lands second.
5. **A replaced file is a new object; the old one is left in place.** Each upload gets a
   fresh key. Once the save points the descriptor at it, every buyer's link (keyed by order
   and sku) serves the new file. The old object is not deleted: deleting it at upload or at
   save could cut off a download already in progress, and the console cannot know when the
   last one ends. An upload whose save never happens (a closed tab) is left too. These
   orphans cost storage, never access, since nothing serves a key the descriptor does not
   name. DEPLOYMENT.md §2.1 says how to find and remove them.
6. **Replace only; a file is never removed (product-owner decision, 2026-10-06).** Past
   buyers must never lose access to what they bought, so the console offers no Remove file
   control and the product cannot be switched to Physical while it has a file: the editor
   shows the Physical choice disabled, with the reason ("This product has a download file,
   so it stays Digital. To change the file, use Replace file."), and the store's refusal of
   a file on a physical product stays as the backstop, answered in the same words rather
   than as an invalid price or measurement. The rule also lives in the DOMAIN:
   `updateProductCommerceFields` refuses `downloadAsset: null` on a product whose stored
   row has a file ("a product's download file can be replaced but never removed",
   `InvalidProductFieldError("downloadAsset")`). It reads the row at the edit's own
   watermark, which is sound without a transaction because the store's compare-and-set
   only applies the edit to a row still at that watermark. So no caller — the console,
   a script, a future surface — can detach a file; it can only point at a new one.

## Consequences

- `console-api.ts` stops being the console's only network code: the upload lives in its own
  module, `download-upload-api.ts`, and both modules say so. A source-scanning test
  (`console-network-surface.test.ts`) fails on any other request — a global `fetch`, another
  XHR, a beacon, a socket, a dynamic import — and pins the upload module to one `open()`. The upload uses
  `XMLHttpRequest` rather than `fetch`, because only XHR reports upload progress, and a
  100 MB upload with no progress reads as a hang.
- The site gains its first admin-only endpoint. It trusts `locals.user` as EmDash's auth
  middleware sets it on storefront paths, and it dispatches the plugin's authenticated admin
  route in-process after checking the role itself, as EmDash's own plugin endpoint does
  before dispatching.
- Files over 100 MB cannot be attached. That needs a presigned multipart upload straight to
  R2, with an S3 access key as a Worker secret. Out of scope for v1.
- Orphaned objects accumulate with every replacement and every abandoned upload until
  someone removes them. A sweep would need to list the bucket and know which keys a
  descriptor names, which is a site job with its own cron, not a plugin one.
- The endpoint does not compute a sha256, so `downloadAsset.sha256` stays unset for an
  uploaded file. Computing one would mean hashing the stream on the way to R2, which can be
  added without changing the wire.

### What would reopen this decision

A second console request of any kind; the upload endpoint writing the product; the endpoint
accepting a key, a path or a product kind from the request; the route moving under `/_`,
dropping its origin guard, or going onto the middleware's exempt list; or a way to remove a
product's file.
