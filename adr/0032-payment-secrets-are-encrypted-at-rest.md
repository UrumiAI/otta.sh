# 0032. Payment secrets are encrypted at rest through EmDash secret settings

- Status: accepted
- Date: 2026-10-08
- Supersedes: the acceptance in [ADR-0020](./0020-one-deployable-plugin-owns-commerce-truth.md)
  §2 and its Consequences that these credentials may be stored as plain values, for the four
  keys below.

## Context

Since the fold-in (ADR-0020 §2), the Stripe secret key, the Stripe webhook signing secret, the
webhook edge token and the x402 facilitator key live in plugin `ctx.kv` under `settings:*`
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

1. **Declare the four keys `secret`.** `@otta-sh/plugin` exports
   `PAYMENT_SECRET_SETTINGS_SCHEMA` (`stripeSecretKey`, `stripeWebhookSecret`,
   `otta-wh-token`, `x402FacilitatorApiKey`), and the site's Otta descriptor declares it as
   `settingsSchema`. The site-config test pins the two equal. The Settings page and every
   reader keep calling `ctx.kv`; EmDash encrypts and decrypts. The Stripe publishable key and
   all other settings are unchanged. The email keys are not included: they are being removed
   (ADR-0031's email change), not migrated.
2. **Re-save stored values once.** The cron tick runs `encryptStoredPaymentSecrets` once per
   site: for each key, `getVersioned`, then `compareAndSet` at that revision with the same
   value (one statement that replaces the row with its envelope), then read back. A marker
   (`state:paymentSecretsEncrypted`, naming the key set) is written only after every key read
   back equal. It is idempotent, safe to interrupt (the row always holds the old form or the
   new one), never overwrites a key saved in between, and logs a fixed line, never a value.
3. **Fail closed.** A key that cannot be read is never used and never replaced by anything
   else. `readSecret` reports it as `unreadable`; payment readers treat it as not configured;
   the webhook edge-token gate answers 503 instead of passing through; the Settings page says
   "saved, but cannot be read" and keeps Remove; a save the host refuses says so.
4. **`EMDASH_ENCRYPTION_KEY` is required** and documented as such in `DEPLOYMENT.md`, with
   what loss and rotation mean.

## Consequences

- A database export, backup or Time Travel snapshot taken after the re-save holds ciphertext
  for these keys, not the keys. Snapshots taken before it still hold the earlier copies until
  they age out, so a live Stripe key should be rotated after the upgrade.
- The plugin process still sees the decrypted values at runtime; ADR-0020 §2's in-process
  widening is unchanged. This decision is about storage, not about who in the process can read
  them.
- Losing `EMDASH_ENCRYPTION_KEY` loses these four keys (they must be entered again). A missing
  key stops Stripe payments and webhooks until it is set — deliberately.
- Declaring a settings schema makes EmDash show a Settings gear for the plugin; its form writes
  the same encrypted keys without Otta's shape checks. Otta's Settings page remains where they
  are entered.
- Encryption depends on the site descriptor. A site that drops `settingsSchema` stores these
  keys as plain values again, and the plugin cannot detect it; the site-config test is the
  guard.
