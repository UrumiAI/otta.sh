# 0037. Payment secrets are encrypted at rest through EmDash secret settings

- Status: accepted
- Note (2026-10-14): the one-time purges of the retired email and x402 keys named in
  Decision 1 were removed (issue #455). Those keys are still not encrypted or migrated;
  nothing reads them.
- Date: 2026-10-08
- Supersedes: the acceptance in [ADR-0020](./0020-one-deployable-plugin-owns-commerce-truth.md)
  §2 and its Consequences that these credentials may be stored as plain values, for the three
  keys below.

## Context

Since the fold-in (ADR-0020 §2), the Stripe secret key, the Stripe webhook signing secret and
the webhook edge token live in plugin `ctx.kv` under `settings:*`
(`packages/plugin/src/payment-secrets.ts`). They were write-only in the admin, but the stored
value was the credential itself, JSON-encoded in the `options` table. ADR-0020 accepted that
because the project was pre-launch with no live credentials. That reason ends at launch.

EmDash 1.0.1 (adopted in PR #322) encrypts a plugin setting at rest when the plugin's
`admin.settingsSchema` declares the field `type: "secret"`:

- `ctx.kv` sends every `settings:*` key to the settings layer (emdash
  `src/plugins/context.ts:134-176`; in a sandbox, `@emdash-cms/cloudflare`
  `src/sandbox/bridge.ts` `kvGet`/`kvSet`), which encrypts a declared secret on write and
  decrypts it on read (`src/plugins/settings.ts:177-229`).
- The cipher is AES-GCM with a random 12-byte IV, the plugin id and key bound in as additional
  data, under `EMDASH_ENCRYPTION_KEY` (`settings.ts:85-171`). The stored row is an envelope
  `{ "$emdash": "plugin-setting", v, kid, iv, ciphertext }` in the same `options` row
  (`plugin:<id>:settings:<name>`).
- The key comes from the `EMDASH_ENCRYPTION_KEY` environment value; a comma-separated list
  rotates (the first encrypts, all decrypt by `kid`) (`src/config/secrets.ts:160-257`).
- A write with no key is refused before anything is stored; a read of an envelope with no key,
  or with only other keys, rejects (`settings.ts:85-147`). A plain string stored before the
  declaration is still returned as it is (`settings.ts:214-218`).

Otta's admin uses its own Block Kit Settings page, which writes with `ctx.kv.set` — the same
path — so no new write path or crypto is needed.

## Decision

1. **Declare the three keys `secret`.** `@urumi.ai/otta-plugin` exports
   `PAYMENT_SECRET_SETTINGS_SCHEMA` (`stripeSecretKey`, `stripeWebhookSecret`,
   `otta-wh-token`), and the site's Otta descriptor declares it as
   `settingsSchema`. The site-config test pins the two equal. The Settings page and every
   reader keep calling `ctx.kv`; EmDash encrypts and decrypts. The Stripe publishable key and
   all other settings are unchanged. The retired email and x402 keys are not included: x402 is
   removed (#437) and email goes through `ctx.email` (ADR-0031); each has its own one-time
   purge (removed, #455) that deletes those stored keys, so they are deleted, not migrated.
2. **Re-save stored values, and again when one is rewritten.** The cron tick runs
   `encryptStoredPaymentSecrets`, once per isolate. It first reads ALL three keys
   (`getVersioned`) and writes nothing if any read fails, so a wrong key can never re-encrypt
   a working plain key while a ciphertext it cannot open exists. The marker
   (`state:paymentSecretsEncrypted`) names the key set and records, per stored key, the
   revision this re-save wrote; a key whose current revision matches is skipped (#478). Every
   other key (all of them on the first run, or after an earlier build's `v1:` marker) gets
   `compareAndSet` at the preflight revision with the same value (one statement that replaces
   the row with a fresh envelope) and a read-back of that exact revision, which is then
   recorded in the marker, so an unfinished run does not redo it. So a key an earlier build
   stores in plain text again (a rollback) is encrypted by the first isolate after rolling
   forward. The marker is written with plain `kv.set`, so two isolates running at once can
   drop each other's entries; that only costs one extra re-save of the affected key (same
   value, fresh envelope), so there is no locking. A conditional write that does not apply
   although the revision is unchanged (a sandboxed bridge's pre-1.0 copy outside the options
   table) is redone as `compareAndSet(key, null, value)`, which applies only while the
   options row is still absent; the bridge stores it encrypted and deletes that copy. It
   reads and writes no x402 or email key, present or absent. Idempotent, safe to interrupt,
   never overwrites a key saved in between, logs fixed lines and counts, never a value. If
   every key is still plain, a wrong key cannot be detected: the key set at that tick is the
   key they are saved under.
3. **Fail closed, and validate on read.** A key that cannot be read, or whose stored value is
   empty, not a string, or not the shape Otta's Settings form saves (the same checks), is
   never used and never replaced by anything else. `readSecret` reports `unreadable` or
   `invalid`; payment readers treat both as not configured; the webhook edge-token gate
   answers 503 instead of passing through (a never-set token still passes through).
   "Unreadable" also covers a kv read failure when nothing was ever stored: whether a value
   exists is then unknown, so the gate answers 503 (fail closed); the
   Settings page says "saved, but cannot be read" or "saved, but not valid" and keeps Remove;
   a save the host refuses says so.
4. **`EMDASH_ENCRYPTION_KEY` is required** and documented as such in `DEPLOYMENT.md`, with
   what loss and rotation mean.

## Consequences

- A database export, backup or Time Travel snapshot taken after the re-save holds ciphertext
  for these keys, not the keys. Snapshots taken before it still hold the earlier copies until
  they age out, so a live Stripe key should be rotated after the upgrade.
- The plugin process still sees the decrypted values at runtime; ADR-0020 §2's in-process
  widening is unchanged. This decision is about storage, not about who in the process can read
  them.
- Losing `EMDASH_ENCRYPTION_KEY` loses these three keys (they must be entered again). A missing
  key stops Stripe payments and webhooks until it is set — deliberately.
- Declaring a settings schema makes EmDash show a Settings gear for the plugin; its form writes
  the same encrypted keys without Otta's shape checks. It is kept (product decision); validate
  on read means a value it stores in the wrong shape is refused rather than used. Otta's
  Settings page remains where they are entered.
- In TRUSTED mode the plugin cannot see the sandbox's pre-1.0 `_plugin_storage` `__kv` rows,
  so a copy left there by an earlier sandboxed deployment of the same database is not removed
  by the re-save. Otta has only run trusted, so none is expected.
- A key rotation and a schema declared only later leave every revision unchanged, so the
  re-save does not repeat by itself: the old key stays listed until the three keys are
  entered again, or until `state:paymentSecretsEncrypted` is deleted so the next isolate
  re-saves them all under the current key.
- Encryption depends on the site descriptor. A site that drops `settingsSchema` stores new
  saves of these keys as plain values again, and values already encrypted become unreadable;
  the plugin cannot detect it, and the site-config test is the guard.
- A custom site must declare the schema (`PAYMENT_SECRET_SETTINGS_SCHEMA` in its descriptor
  `settingsSchema`) before upgrading. If it was added later, enter the three keys again in
  Settings, or delete `state:paymentSecretsEncrypted` so the re-save runs again.
