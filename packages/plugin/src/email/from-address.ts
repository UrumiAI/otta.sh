/**
 * Could a real email provider send from this address? (The Settings save's
 * from-address check.)
 *
 * THE FAILURE IT PREVENTS. A real provider — Resend, the one DEPLOYMENT.md
 * documents — refuses any sending domain the account has not verified, and a
 * reserved name can never be verified. Saving one used to produce a screen that
 * said "saved" and an outbox whose every send was refused on a cron tick nobody
 * watches. Refusing at save time puts the failure in front of the operator, the
 * same way the save already refuses a bad sign-in link URL.
 *
 * WHAT IT CANNOT KNOW: whether the domain IS verified with the provider. That
 * refusal is the provider's, and it arrives as a send error naming the reason
 * (`ctx-http-email-sender.ts`). This catches placeholders and typos, nothing
 * more — deliberately a shape check rather than an RFC 5322 parser, because the
 * provider is the authority on the full grammar.
 *
 * NOT APPLIED TO THE RUNTIME DEFAULT. `DEFAULT_EMAIL_FROM` (`no-reply@otta.local`)
 * fails this check by design: it is the dev fallback a local mail catcher
 * accepts, used only when nothing was saved.
 */

/**
 * Top-level names that can never carry real mail: RFC 2606 (`test`, `example`,
 * `invalid`, `localhost`), RFC 6762 (`local`, mDNS), RFC 7686 (`onion`), RFC
 * 9476 (`alt`) and ICANN's private-use `internal`.
 */
const NON_DELIVERABLE_TLDS: ReadonlySet<string> = new Set([
	"local",
	"localhost",
	"test",
	"example",
	"invalid",
	"internal",
	"onion",
	"alt",
]);

/** Reserved names below the top level: RFC 2606 §3's documentation domains
 *  (example.com publishes a null MX, RFC 7505) and RFC 8375's residential
 *  `home.arpa`. A subdomain of one is refused too. */
const NON_DELIVERABLE_DOMAINS: readonly string[] = [
	"example.com",
	"example.net",
	"example.org",
	"home.arpa",
];

/** C0 and C1 controls, DEL, and the Unicode line/paragraph separators. A line
 *  break in a from-address (`Shop\r\nBcc: …`) is a header injection waiting
 *  for any transport that writes headers from it. */
// oxlint-disable-next-line no-control-regex -- matching control characters IS the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** A display name: a quoted string (anything but a bare `"` or `\`, or an
 *  escaped pair), or an unquoted run with none of `,` `;` `"` — unquoted, a
 *  comma makes the header two mailboxes and a semicolon ends a group. */
const DISPLAY_NAME = /^(?:"(?:[^"\\]|\\.)*"|[^,;"<>]*)$/u;

/** One DNS label: letters, digits and inner hyphens, never at either end. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/** The TLD: alphabetic (two or more letters), or the punycode form of an
 *  internationalized one. Rules out IP literals (`1.2.3.4`) and numeric TLDs. */
const TLD = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/u;

/**
 * Accepts the two forms Resend's `from` takes — a bare `addr@domain` and
 * `Name <addr@domain>` (the sender passes the value through verbatim, so a
 * display name reaches the provider intact). Refuses any control character, an
 * unquoted `,` `;` or `"` in the display name, a `,` or `;` in the local part,
 * a malformed address, a single-label domain (`no-reply@localhost`, a bare
 * intranet host), an IP literal, a label with a leading or trailing hyphen, a
 * non-alphabetic TLD, and a domain under a reserved name. An internationalized domain is accepted in
 * its ASCII `xn--` form only — the banner says so — rather than converting
 * Unicode here, so what is stored is exactly what the provider is sent.
 */
export function isDeliverableFromAddress(value: string): boolean {
	if (CONTROL_CHARS.test(value)) return false;
	const trimmed = value.trim();
	const named = /^([^<>]*)<([^<>]+)>$/u.exec(trimmed);
	if (named !== null && !DISPLAY_NAME.test((named[1] ?? "").trim())) return false;
	const address = named?.[2] ?? trimmed;
	// No `,` or `;` in the local part either — in either form, a comma would make
	// the header two mailboxes.
	const domain = /^[^\s@<>",;]+@([^\s@<>]+)$/u.exec(address)?.[1]?.toLowerCase();
	if (domain === undefined) return false;
	const labels = domain.split(".");
	const tld = labels.at(-1) ?? "";
	if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(tld)) return false;
	if (NON_DELIVERABLE_TLDS.has(tld)) return false;
	return !NON_DELIVERABLE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * The display name of a From address — `Goa Coffee <orders@goa.coffee>` →
 * `Goa Coffee` — or `undefined` for a bare address or an empty name. A quoted
 * name is unquoted (`\"` and `\\` unescaped). The emails fall back to it when
 * "Store display name" is unset (QA2 U-3): the From line already says who the
 * mail is from, so the body may too.
 */
export function fromDisplayName(from: string): string | undefined {
	const match = /^\s*(.*?)\s*<[^<>]*>\s*$/su.exec(from);
	if (match === null) return undefined;
	let name = match[1] ?? "";
	const quoted = /^"((?:[^"\\]|\\.)*)"$/su.exec(name);
	if (quoted !== null) name = (quoted[1] ?? "").replace(/\\(.)/gsu, "$1");
	name = name.trim();
	return name.length > 0 ? name : undefined;
}
