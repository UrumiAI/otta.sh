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
import type { EmailSender } from "./email-from.js";
import { parseWrangler } from "./wrangler-jsonc.js";

/** The binding name `cloudflareEmail({ binding })` is registered with. */
export const EMAIL_BINDING = "EMAIL";

function senderAddress(sender: EmailSender): string {
	return typeof sender === "string" ? sender : sender.email;
}

/**
 * @param sender the configured sender. A binding that restricts senders
 *   (`allowed_sender_addresses`) must list it; one that restricts RECIPIENTS
 *   (`destination_address`, `allowed_destination_addresses`) is refused outright,
 *   because the site mails arbitrary buyers and every blocked send is a counted
 *   attempt, the same burn this guard exists to stop.
 */
export function assertEmailBindingDeclared(
	wranglerText: string,
	fileName: string,
	sender?: EmailSender,
): void {
	const config = parseWrangler(wranglerText, fileName, "its send_email binding");
	const entries = config["send_email"];
	const binding = Array.isArray(entries)
		? (entries.find(
				(e) =>
					typeof e === "object" && e !== null && (e as { name?: unknown }).name === EMAIL_BINDING,
			) as Record<string, unknown> | undefined)
		: undefined;
	if (binding === undefined) {
		throw new Error(
			`OTTA_EMAIL_FROM is set but ${fileName} declares no send_email binding named ` +
				`"${EMAIL_BINDING}". Add "send_email": [{ "name": "${EMAIL_BINDING}" }] to ${fileName} ` +
				"(after the sender domain is active on Cloudflare Email Sending and the plan is " +
				"Workers Paid; DEPLOYMENT.md §3, Email), or unset OTTA_EMAIL_FROM. A selected " +
				"provider with no binding fails every send and parks order emails as failed.",
		);
	}
	for (const key of ["destination_address", "allowed_destination_addresses"]) {
		if (binding[key] !== undefined) {
			throw new Error(
				`OTTA_EMAIL_FROM is set but the "${EMAIL_BINDING}" send_email binding in ${fileName} ` +
					`sets ${key}, which blocks sends to buyers. Remove it: the site mails arbitrary ` +
					"recipients, and each blocked send is a counted attempt that parks order emails as failed.",
			);
		}
	}
	const allowed = binding["allowed_sender_addresses"];
	if (allowed !== undefined) {
		const want = sender === undefined ? undefined : senderAddress(sender).toLowerCase();
		const ok =
			Array.isArray(allowed) &&
			want !== undefined &&
			allowed.some((a) => typeof a === "string" && a.toLowerCase() === want);
		if (!ok) {
			throw new Error(
				`OTTA_EMAIL_FROM is set but the "${EMAIL_BINDING}" send_email binding in ${fileName} ` +
					`restricts allowed_sender_addresses and does not list the configured sender` +
					`${want === undefined ? "" : ` ${want}`}. Add it, or remove the restriction.`,
			);
		}
	}
}

/**
 * The build's whole select + read + guard step, pure so both outcomes are tested
 * with fixtures instead of the machine's gitignored `wrangler.local.jsonc`.
 * No-op when no sender is configured. Returns the file name it checked.
 */
export function assertEmailBindingForBuild(
	sender: EmailSender | undefined,
	files: { localText?: string; templateText: string },
): string | undefined {
	if (sender === undefined) return undefined;
	const fileName = files.localText !== undefined ? "wrangler.local.jsonc" : "wrangler.jsonc";
	assertEmailBindingDeclared(files.localText ?? files.templateText, fileName, sender);
	return fileName;
}
