/**
 * The SMTP2GO `EmailSender` — SMTP2GO's HTTP send API, `POST /v3/email/send`.
 *
 * THE REQUEST (checked against the live API, 2026-10-05):
 *  - the key in `X-Smtp2go-Api-Key`;
 *  - JSON `{ sender, to: [..], subject, html_body, text_body }`, where `sender`
 *    is the from-address as saved ("Name <addr>" or a bare address). No custom
 *    header carries the outbox row id: every recipient can read a message's
 *    headers. SMTP2GO's own `request_id` (quoted in a refusal) and `email_id`
 *    find a message in its activity log.
 *
 * THE RESPONSE. Success is a 200 with `data.succeeded: 1`. A REFUSED send can
 * ALSO be a 200 — `data.failed: 1` with the reason in `data.failures` (an
 * unverified sender domain comes back this way). Reading the status alone would
 * mark the outbox row sent for a message that never left, so a 200 counts only
 * when `data.succeeded` is at least 1 and `data.failed` is 0. Other errors use
 * non-2xx statuses with `{ data: { error_code, error } }`.
 *
 * NO IDEMPOTENCY KEY. SMTP2GO defines none, so "once" rests on the outbox's
 * claim alone: a send the provider accepted but whose answer we lost (a timeout
 * after acceptance, a tick that dies before the row is marked) is sent again.
 * That is the outbox's at-least-once contract, written down in ADR-0005. To keep
 * it bounded, a timeout on this provider is a COUNTED attempt
 * (`countTimeoutsAsAttempts`), so duplicates stop at the row's `maxAttempts`.
 */
import { smtp2goSendUrl, type Smtp2goRegion } from "./email-provider.js";
import {
	EmailProviderError,
	HttpEmailSender,
	type HttpEmailSenderOptions,
	type OutboundEmail,
	type ProviderRequest,
	readProviderJson,
	type ProviderResponse,
	sanitizeProviderDetail,
	statusFailure,
} from "./http-email-sender.js";

export interface Smtp2goEmailSenderOptions extends HttpEmailSenderOptions {
	region: Smtp2goRegion;
}

export class Smtp2goEmailSender extends HttpEmailSender {
	readonly #url: string;

	constructor(options: Smtp2goEmailSenderOptions) {
		super(options);
		this.#url = smtp2goSendUrl(options.region);
	}

	protected buildRequest(message: OutboundEmail): ProviderRequest {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.apiKey !== undefined) headers["X-Smtp2go-Api-Key"] = this.apiKey;
		return {
			url: this.#url,
			headers,
			body: JSON.stringify({
				sender: message.from,
				to: [message.to],
				subject: message.subject,
				html_body: message.html,
				text_body: message.text,
			}),
		};
	}

	protected async checkResponse(res: ProviderResponse, message: OutboundEmail): Promise<void> {
		const parsed = await readProviderJson(res);
		const data = dataOf(parsed);
		if (!res.ok) {
			throw statusFailure(
				res.status,
				sanitizeProviderDetail([data?.["error_code"], data?.["error"]], this.redactions(message)),
			);
		}
		if (data === undefined) {
			// A 2xx that is not SMTP2GO's JSON — an intermediary's page, say. Not
			// taken as sent; none of it is quoted.
			throw new EmailProviderError(
				"ambiguous",
				res.status,
				`email transport failed: SMTP2GO answered ${String(res.status)} without its JSON body, so the send is not known to have succeeded`,
			);
		}
		const succeeded = data["succeeded"];
		const failed = data["failed"];
		if (typeof succeeded === "number" && succeeded >= 1 && failed === 0) return;
		const failures = Array.isArray(data["failures"]) ? (data["failures"] as unknown[]) : [];
		const detail = sanitizeProviderDetail(failures, this.redactions(message));
		const requestId = sanitizeProviderDetail([(parsed as { request_id?: unknown }).request_id], []);
		throw new EmailProviderError(
			"refused",
			res.status,
			`email transport failed: SMTP2GO did not send the message${requestId === undefined ? "" : ` (request ${requestId})`}${detail === undefined ? "" : `: ${detail}`}`,
		);
	}
}

/** `parsed.data` as a record, or `undefined`. */
function dataOf(parsed: unknown): Record<string, unknown> | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const data = (parsed as { data?: unknown }).data;
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}
