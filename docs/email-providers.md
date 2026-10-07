# Bring your own email provider

otta ships no email provider. It hands every email to EmDash, and EmDash hands it to the
**email-transport plugin** you select. Adding a provider means writing that plugin, about
50 lines. A working template is in [`examples/email-provider/`](../examples/email-provider/).

```
otta ──ctx.email.send()──▶ EmDash ──email:deliver──▶ your plugin ──HTTPS──▶ your email API
```

**Start from the template.** Copy `examples/email-provider/` to a new folder under `examples/`
or `packages/` (both are workspace globs). Rename `name` in `package.json`, and the plugin `id`
(`http-email`) and `entrypoint` in `src/index.ts`, so copies don't collide. Set `EMAIL_API_URL`
in `src/plugin.ts`, and change the request body to your API's shape. Run `pnpm install`, then
add `{ "path": "<your-folder>" }` to the root `tsconfig.json` references so `pnpm typecheck`
covers it.

## The hook (emdash 0.38)

A provider registers one **exclusive** `email:deliver` hook and declares the
`hooks.email-transport:register` capability. Without that capability, EmDash skips the hook
with a warning. Without `exclusive: true`, the plugin never shows up as a provider.

```ts
import type { EmailDeliverEvent, PluginContext, SandboxedPlugin } from "emdash/plugin";

// Types from emdash, for reference:
// interface EmailDeliverEvent { message: EmailMessage; source: string } // source "otta" for otta's mail
// interface EmailMessage { to: string; subject: string; text: string; html?: string }

// The slice of PluginContext the handler uses. Tests can then pass a plain { kv, http } object.
export interface DeliverContext {
	kv: Pick<PluginContext["kv"], "get">;
	http?: PluginContext["http"];
}

export async function deliver(event: EmailDeliverEvent, ctx: DeliverContext): Promise<void> {
	/* POST event.message to your email API with ctx.http.fetch; throw on failure */
}

export default {
	hooks: { "email:deliver": { exclusive: true, handler: deliver } },
} satisfies SandboxedPlugin;
```

The message has no `from` and no idempotency key. Your plugin supplies the sender.

## The contract

- **Throw to fail.** Resolving means "accepted". Any throw is a failed send, and EmDash
  passes the error back to otta. otta keeps the order email in its outbox and retries it on
  a later sweep, up to the outbox's attempt limit. A failed login email is logged, not retried,
  and the shopper can request a new code.
- **Be fast.** otta waits 3 s when a shopper is waiting (the login code, and the order email
  right after payment), and 5 s per email in the background sweep. EmDash also stops waiting at
  the hook's `timeout`, which defaults to 5000 ms. Aim well under 3 s. Timeouts do not cancel
  your handler, so a "timed out" send can still complete afterwards.
- **No AbortSignal.** Don't pass `signal` in the `ctx.http.fetch` options. It cannot cross the
  sandbox boundary, and fails there with `DataCloneError`.
- **At-least-once.** A send that timed out, or succeeded but was not recorded, is sent again.
  If your API supports an `Idempotency-Key` header, send one derived from the message, for
  example a SHA-256 of `to`, `subject` and `text` via `crypto.subtle`. Otherwise recipients
  may occasionally get a duplicate. A content-derived key also suppresses a deliberate
  identical re-send within your API's idempotency window.
- **Don't leak secrets.** Error messages reach logs. Say the status and the host, never the
  API key or the response body. Don't attach the fetch error as `cause`, since it can quote
  your headers. Reject a key with non-printable characters before using it in a header.
- **Sender identity lives in the provider.** The from-address, SPF and DKIM are set up in
  your email API account and in your plugin's settings. otta has no from setting.
- **Egress is declared, https only.** Call the API with `ctx.http.fetch` (`network:request`
  capability), and list its **exact** hostname in `allowedHosts`, never a wildcard. Keep the
  URL in code, not in an admin setting, so settings cannot redirect your key.
- **Raw transports.** If you build MIME or SMTP headers yourself, reject CR/LF in `to` and
  `subject`, and a `to` containing `,` or `;`. A JSON body, as in the template, is safe.

## Settings and secrets

Use EmDash's plugin settings: declare a `settingsSchema` on the descriptor (`type: "secret"`
for the key) and read values in the hook with `ctx.kv.get("settings:<name>")`. Secret fields
are write-only in the admin and are never echoed back.

## Register and select it

1. Add the descriptor to the site's EmDash config, next to otta's:
   ```ts
   import { httpEmailProvider } from "your-email-provider";
   emdash({ plugins: [ottaPluginDescriptor({ egress }), httpEmailProvider()] });
   ```
2. In the EmDash admin, open the plugin under **Extensions** and fill in its settings. Plugins
   from the config are active by default.
3. Choose it under **Settings → Email**. If it is the only active provider, EmDash selects it
   automatically. In `astro dev` EmDash's built-in console provider is active too, so select
   yours explicitly. Until a provider is selected, order emails wait up to 72 hours and are
   then skipped, not sent, so a late setup does not mail stale receipts. Sign-in links are not
   sent at all; the buyer asks for a new one.

## Test it

- **Run one package:** `pnpm exec tsc -b <folder>` (build mode, because the template references
  `packages/plugin`; `tsc -p` fails with TS6305), and `pnpm exec vitest run <folder>` from the
  repo root.
- **Your transport:** call `deliver(event, { kv, http })` with a stubbed `http.fetch`. Check the
  success case, a non-2xx response, and that the API key appears in no error. See
  [`examples/email-provider/test/provider.test.ts`](../examples/email-provider/test/provider.test.ts).
- **Code that sends through otta:** use the fake transport from `@otta-sh/plugin/testing`:
  ```ts
  import { recordingEmailProvider } from "@otta-sh/plugin/testing";
  const email = recordingEmailProvider();
  // As ctx.email: email.send(message). As an email:deliver handler: email.deliver(event), one argument.
  email.fail(new Error("outage")); // every send throws
  email.hang(); // sends never settle, so the caller's timeout fires
  email.succeed(); // back to normal
  // email.attempts: everything sent to it; email.sent: only what succeeded.
  // Like EmDash, it rejects an empty to, subject or text.
  ```
