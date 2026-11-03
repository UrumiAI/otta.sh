/**
 * BUILD-TIME guard for the default email provider (ADR-0043).
 *
 * EmDash auto-selects the only email provider and persists the choice. If
 * `OTTA_EMAIL_FROM` is set but the Worker has no `send_email` binding named
 * `EMAIL`, every send throws a plain Error (not EmailNotConfiguredError), so each
 * one is a COUNTED attempt and an order-email row is parked `failed` after five
 * tries, while sign-in links never arrive. That is worse than no provider, so the
 * build refuses the pair, naming the wrangler file it read.
 *
 * Pure (text in, throw or not out): `test/email-binding-guard.test.ts`.
 */
import { parseWrangler } from "./wrangler-jsonc.js";

/** The binding name `cloudflareEmail({ binding })` is registered with. */
export const EMAIL_BINDING = "EMAIL";

export function assertEmailBindingDeclared(wranglerText: string, fileName: string): void {
	const config = parseWrangler(wranglerText, fileName, "its send_email binding");
	const entries = config["send_email"];
	const declared =
		Array.isArray(entries) &&
		entries.some(
			(e) =>
				typeof e === "object" && e !== null && (e as { name?: unknown }).name === EMAIL_BINDING,
		);
	if (!declared) {
		throw new Error(
			`OTTA_EMAIL_FROM is set but ${fileName} declares no send_email binding named ` +
				`"${EMAIL_BINDING}". Add "send_email": [{ "name": "${EMAIL_BINDING}" }] to ${fileName} ` +
				"(after the sender domain is active on Cloudflare Email Sending and the plan is " +
				"Workers Paid; DEPLOYMENT.md §3, Email), or unset OTTA_EMAIL_FROM. A selected " +
				"provider with no binding fails every send and parks order emails as failed.",
		);
	}
}
