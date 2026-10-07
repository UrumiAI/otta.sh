# Bring your own email provider

otta ships no email provider. It hands every email to EmDash, and EmDash hands it to the
**email-transport plugin** you select. Adding a provider means writing that plugin, about
50 lines. A working template is in [`examples/email-provider/`](../examples/email-provider/).

```
otta ──ctx.email.send()──▶ EmDash ──email:deliver──▶ your plugin ──HTTP──▶ your email API
```

## The hook (emdash 0.38)

A provider registers one **exclusive** `email:deliver` hook and declares the
`hooks.email-transport:register` capability. Without that capability, EmDash skips the hook
with a warning. Without `exclusive: true`, the plugin never shows up as a provider.

```ts
import type { EmailDeliverEvent, PluginContext, SandboxedPlugin } from "emdash/plugin";

// Types from emdash, for reference:
// interface EmailDeliverEvent { message: EmailMessage; source: string } // source "otta" for otta's mail
// interface EmailMessage { to: string; subject: string; text: string; html?: string }

export default {
	hooks: {
		"email:deliver": {
			exclusive: true,
			handler: async (event: EmailDeliverEvent, ctx: PluginContext): Promise<void> => {
				/* POST event.message to your email API with ctx.http.fetch; throw on failure */
			},
		},
	},
} satisfies SandboxedPlugin;
```

The message has no `from` and no idempotency key. Your plugin supplies the sender.

## The contract

- **Throw to fail.** Resolving means "accepted". Any throw is a failed send, and EmDash
  passes the error back to otta. otta keeps the order email in its outbox and retries it on
  a later sweep, up to the outbox's attempt limit. A failed login email is logged, not retried,
  and the shopper can request a new code.
- **Be fast.** otta waits 3 s for a login email and 5 s per email in the sweep. EmDash also
  stops waiting at the hook's `timeout`, which defaults to 5000 ms. A slow send counts as a
  failure, but the request may still land.
- **At-least-once.** A send that timed out, or succeeded but was not recorded, is sent
  again. Recipients can get a duplicate. Make the send safe to repeat, and keep it quick.
- **Don't leak secrets.** Error messages reach logs. Say the status and the host, never the
  API key or the response body.
- **Sender identity lives in the provider.** The from-address, SPF and DKIM are set up in
  your email API account and in your plugin's settings. otta has no from setting.
- **Egress is declared.** Call the API with `ctx.http.fetch` (`network:request` capability),
  and list the API host in `allowedHosts`. EmDash rejects any other host.

## Settings and secrets

Use EmDash's plugin settings: declare a `settingsSchema` on the descriptor (`type: "secret"`
for the key) and read values in the hook with `ctx.kv.get("settings:<name>")`. Secret fields
are write-only in the admin and are never echoed back.

## Register and select it

1. Make the plugin importable by your site (a workspace package works), and point the
   descriptor's `entrypoint` at the module that default-exports the plugin.
2. Add the descriptor to the site's EmDash config, next to otta:
   ```ts
   import { httpEmailProvider } from "your-email-provider";
   emdash({
   	plugins: [ottaDescriptor, httpEmailProvider({ apiHost: "api.mail.example.net" })],
   });
   ```
3. In the EmDash admin, activate the plugin under **Extensions** and fill in its settings.
4. Choose it under **Settings → Email**. If it is the only active provider, EmDash selects it
   automatically. Until a provider is selected, otta's emails stay queued.

## Test it

- **Your transport:** call your handler with a stubbed `ctx.http.fetch`. Check the success
  case, a non-2xx response, and that the API key appears in no error. See
  [`examples/email-provider/test/provider.test.ts`](../examples/email-provider/test/provider.test.ts).
- **Code that sends through otta:** use the fake transport from `@otta-sh/plugin/testing`:
  ```ts
  import { recordingEmailProvider } from "@otta-sh/plugin/testing";
  const email = recordingEmailProvider(); // use as ctx.email, or as an email:deliver handler
  email.fail(new Error("outage")); // every send throws
  email.hang(); // sends never settle, so the caller's timeout fires
  email.succeed(); // back to normal
  // email.attempts: everything sent to it; email.sent: only what succeeded
  ```
