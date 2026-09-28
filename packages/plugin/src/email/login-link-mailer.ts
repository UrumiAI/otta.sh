/**
 * The magic-link sign-in email (issue #306).
 *
 * Before this, `requestLoginLink` recorded the challenge and sent nothing: the
 * old service mailed the link, and the fold-in moved the challenge in-process
 * without the mail. This module is the missing half — it builds the link from
 * operator config and sends it through the same `EmailSender` port and
 * `CtxHttpEmailSender` adapter the order emails use.
 *
 * WHERE THE LINK POINTS COMES FROM CONFIG, NEVER FROM THE REQUEST. The obvious
 * shortcut — the origin of the request that asked for the link — is host-header
 * poisoning: anyone could ask for a victim's link with a forged `Host`, and the
 * victim's inbox would receive a working token pointing at the attacker's
 * domain. So the verify page is an absolute URL the operator saves in Settings
 * (`settings:loginLinkUrl`), and the challenge id and token are appended to it as
 * the `challengeId` and `token` query parameters.
 *
 * FAIL-CLOSED AND SILENT. No verify URL, no email API URL in this build: nothing
 * is sent, and the caller still answers the same generic success — this surface
 * must never tell a caller anything about an address, and "mail is not
 * configured" is not a fact about the address either. A transport failure DOES
 * reject: that is infrastructure, like a storage failure, and it happens for
 * every address alike.
 */
import type { Email, EmailSender } from "@otta-sh/domain";
import type { PluginContext } from "../types.js";
import { makeEmailSender, type EmailSenderEgress } from "./ctx-http-email-sender.js";

/** The storefront page that redeems a sign-in link — an absolute http(s) URL.
 *  Readable kv, like the from-address: an operator must see where links point. */
export const LOGIN_LINK_URL_KEY = "settings:loginLinkUrl";

/** The language customer emails are written in (`en` default, `fr`). */
export const EMAIL_LOCALE_KEY = "settings:emailLocale";

/** Sends one sign-in link. The client calls it only for an issued (not
 *  throttled) challenge. */
export interface LoginLinkMailer {
	send(input: { to: Email; challengeId: string; token: string }): Promise<void>;
}

/** Is this a URL a sign-in link may point at? Absolute, http or https, and with
 *  no credentials in it. Shared by the settings save path and the send path, so
 *  a value that could not be saved can never be used either. */
export function isValidLoginLinkUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return (
		(url.protocol === "https:" || url.protocol === "http:") &&
		url.username === "" &&
		url.password === ""
	);
}

/** The link the email carries: the configured page plus the two parameters its
 *  verify call needs. Existing query parameters on the page are kept. */
export function buildLoginLinkUrl(base: string, challengeId: string, token: string): string {
	const url = new URL(base);
	url.searchParams.set("challengeId", challengeId);
	url.searchParams.set("token", token);
	return url.toString();
}

/** A mailer over an explicit sender and settings — the testable core. */
export function loginLinkMailer(options: {
	sender: EmailSender;
	loginLinkUrl: string;
	locale?: string | undefined;
}): LoginLinkMailer {
	return {
		async send({ to, challengeId, token }) {
			await options.sender.send({
				to,
				template: "customer-login-link",
				data: {
					loginUrl: buildLoginLinkUrl(options.loginLinkUrl, challengeId, token),
					...(options.locale !== undefined ? { locale: options.locale } : {}),
				},
				// One challenge, one email: a provider that dedupes on the key drops a
				// retried send of the same challenge.
				idempotencyKey: `login-${challengeId}`,
			});
		},
	};
}

/**
 * The deployment's mailer, resolved from `ctx` at SEND time rather than at
 * client construction: a commerce client is built for every storefront call,
 * and only this one needs the three kv reads.
 */
export function ctxLoginLinkMailer(ctx: PluginContext, egress: EmailSenderEgress): LoginLinkMailer {
	return {
		async send(input) {
			const loginLinkUrl = await readString(ctx, LOGIN_LINK_URL_KEY);
			if (loginLinkUrl === undefined || !isValidLoginLinkUrl(loginLinkUrl)) return;
			const sender = await makeEmailSender(ctx, egress);
			if (sender === undefined) return;
			const locale = await readString(ctx, EMAIL_LOCALE_KEY);
			await loginLinkMailer({ sender, loginLinkUrl, locale }).send(input);
		},
	};
}

/** A non-empty kv string, or `undefined` — fail-soft on a kv rejection, which
 *  degrades to "not configured" (nothing sent) rather than a thrown request. */
async function readString(ctx: PluginContext, key: string): Promise<string | undefined> {
	try {
		const value = await ctx.kv.get<string>(key);
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}
