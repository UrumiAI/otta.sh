/**
 * Build-time sender for the reference site's default email provider
 * (ADR-0043). `OTTA_EMAIL_FROM` is a plain address, `OTTA_EMAIL_FROM_NAME` an
 * optional display name. Neither is a secret. Validated HERE so a typo fails
 * the build loudly rather than surfacing as a bounced sign-in email.
 *
 * Deliberately strict: no angle-bracket form, no whitespace, no control
 * characters (a CR/LF would be header injection into the From line).
 */

/** What `cloudflareEmail({ from })` accepts. */
export type EmailSender = string | { email: string; name?: string };

// local@label.label — ASCII only (no IDN / internationalised addresses, on both sides of
// the @), one @, a dot-atom local part (no leading, trailing or doubled dots), and a dotted
// domain of LDH labels. Control characters are rejected separately.
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function isAddress(value: string): boolean {
	const at = value.indexOf("@");
	if (at <= 0 || at !== value.lastIndexOf("@")) return false;
	return LOCAL.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1));
}
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
	if (!isAddress(email)) {
		throw new Error(
			`OTTA_EMAIL_FROM: ${JSON.stringify(email)} is not a plain email address ` +
				"(expected ASCII only, like store@example.com: no display name, angle brackets, " +
				"control characters, stray dots or non-ASCII/IDN characters; use " +
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
