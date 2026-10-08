---
"@otta-sh/plugin": minor
---

Encrypt payment secrets at rest via EmDash secret settings (ADR-0032).

- **Declared `secret`.** New export `PAYMENT_SECRET_SETTINGS_SCHEMA` declares the Stripe
  secret key, the Stripe webhook signing secret, the webhook edge token and the x402
  facilitator key as `type: "secret"`. A deploying site must put it in its Otta descriptor's
  `settingsSchema` (the reference site does); EmDash 1.0.1 then encrypts those `settings:*`
  values with `EMDASH_ENCRYPTION_KEY` on every write and decrypts them on read. The Settings
  page and the readers are unchanged `ctx.kv` calls. `EMDASH_ENCRYPTION_KEY` is now required.
- **One-time re-save.** The sweep's cron tick re-saves values stored by earlier builds through
  the same path, once per site (`encryptStoredPaymentSecrets`, marker
  `state:paymentSecretsEncrypted`): a conditional write at the read revision, then a
  read-back, then the marker. Idempotent, safe to interrupt, never logs a value.
- **Fail closed.** New `readSecret` tells set, unset and unreadable apart. A key that cannot
  be decrypted reads as not configured; the webhook edge-token gate now answers 503
  `NOT_CONFIGURED` when its token is stored but unreadable (or the kv read fails) instead of
  passing through; the Settings page shows "saved, but cannot be read" and keeps Remove; a
  save the host refuses is reported as not saved.
- `KvAccess` gains the host's optional `getVersioned`/`compareAndSet`, and `PluginContext`
  the optional `site`.

New exports: `ENCRYPTED_PAYMENT_SECRET_KEYS`, `PAYMENT_SECRET_SETTINGS_SCHEMA`, `readSecret`,
`SecretRead`, `SecretSettingFieldSpec`, `encryptStoredPaymentSecrets`,
`EncryptPaymentSecretsOutcome`, `PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY`,
`PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE`, `resetPaymentSecretEncryptionForTesting`.
