/**
 * Build-time sender for the reference site's default email provider
 * (ADR-0042). `OTTA_EMAIL_FROM` is a plain address, `OTTA_EMAIL_FROM_NAME` an
 * optional display name. Neither is a secret. Validated HERE so a typo fails
 * the build loudly rather than surfacing as a bounced sign-in email.
 *
 * Deliberately strict: no angle-bracket form, no whitespace, no control
 * characters (a CR/LF would be header injection into the From line).
 */

/** What `cloudflareEmail({ from })` accepts. */
export type EmailSender = string | { email: string; name?: string };

// local@label.label — one @, no whitespace/quotes/angle brackets, a dotted domain.
const ADDRESS =
	/^[^\s@<>"'(),;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const NAME_FORBIDDEN = /[\p{Cc}<>"]/u;

/** @returns undefined when no sender is configured (register no provider). */
export function parseEmailFrom(
	address: string | undefined,
	name: string | undefined,
): EmailSender | undefined {
	const email = address?.trim() ?? "";
	const displayName = name?.trim() ?? "";
	if (email === "") {
		if (displayName !== "") {
			throw new Error(
				"OTTA_EMAIL_FROM_NAME is set but OTTA_EMAIL_FROM is not. Set OTTA_EMAIL_FROM to the " +
					"sender address, or remove OTTA_EMAIL_FROM_NAME.",
			);
		}
		return undefined;
	}
	if (!ADDRESS.test(email)) {
		throw new Error(
			`OTTA_EMAIL_FROM: ${JSON.stringify(email)} is not a plain email address ` +
				"(expected store@example.com, no display name or angle brackets; use " +
				"OTTA_EMAIL_FROM_NAME for the name).",
		);
	}
	if (displayName === "") return email;
	if (NAME_FORBIDDEN.test(displayName)) {
		throw new Error(
			`OTTA_EMAIL_FROM_NAME: ${JSON.stringify(displayName)} must not contain control ` +
				"characters, quotes or angle brackets.",
		);
	}
	return { email, name: displayName };
}
