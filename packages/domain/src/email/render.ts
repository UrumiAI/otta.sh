import { orderLabel, type OrderLabelLine } from "../orders/order-label.js";
import type { EmailTemplate } from "../ports/email-sender.js";

export interface RenderedEmail {
	subject: string;
	text: string;
	html: string;
}

/**
 * Render an email from a template + explicit data (Phase 5 §6). Plain-text +
 * HTML pair, interpolated (no concatenation of user data into markup beyond
 * escaping) so the templates stay i18n-ready. No template reaches back into a
 * store — it renders only what the dispatcher passed it.
 */
export function renderEmail(template: EmailTemplate, data: Record<string, unknown>): RenderedEmail {
	if (template === "customer-login-link") {
		const loginUrl = str(data["loginUrl"]);
		const link = loginUrl ?? str(data["challengeId"]) ?? "";
		const subject = "Your sign-in link";
		const footer =
			"This link is single-use and expires shortly. If you didn't request it, you can ignore this email.";
		const text = `Click to sign in: ${link}\n\n${footer}`;
		// The link is an ANCHOR — a bare URL in a paragraph is not clickable in every
		// client — and the href is escaped exactly like the text: the URL is built
		// from operator config and a token, and neither is markup. (Adapted from #325
		// by @stephanedemotte.)
		const shown =
			loginUrl !== undefined
				? `<a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a>`
				: escapeHtml(link);
		return {
			subject,
			text,
			html: paragraph(`Click to sign in: ${shown}`) + paragraph(escapeHtml(footer)),
		};
	}

	// The order is named by WHAT WAS BOUGHT, never by its id (`orderLabel`): the
	// recipient is the buyer, and a UUID names nothing they bought. The id still
	// travels in `data.orderId` — the dispatcher keys on it — it is just not
	// rendered. The label is plain text: escaped below like every other value.
	const label = orderLabel(labelLines(data["lines"]));
	// A refund email states its OWN figure (`noticeAmountCents`, the refunded money),
	// not the order total — a late capture or a partial refund differs from it.
	// Labelled for what it is. The ONE "amount refunded" path: notices (late payment,
	// partial refund) and the `refunded` state email alike (ADR-0026).
	const isNotice = data["noticeAmountCents"] !== undefined;
	const total = isNotice
		? formatMoney(data["noticeAmountCents"], str(data["noticeCurrency"]))
		: formatMoney(data["totalCents"], str(data["currency"]));
	const totalLabel = isNotice ? "Refunded" : "Total";
	const copy = latePaymentCopyFor(template, str(data["state"])) ?? ORDER_COPY[template];
	const subject = `${copy.subject} — ${label}`;
	// The shipped email carries the recorded tracking (admin-UX Increment 1) so it
	// is no longer an empty "on its way" — rendered only when the order was
	// fulfilled and the data carries it (any other template ignores fulfillment).
	const tracking = template === "order-shipped" ? trackingLines(data["fulfillment"]) : null;
	// "Cancel with reason" slice: the cancelled email may carry WHY — but ONLY
	// through the explicit CUSTOMER-SAFE mapping below (PR #64 review blocker).
	// The recipient is the buyer, so sensitive reasons (fraud_suspected,
	// pricing_error, other) and the admin's free-text detail must NEVER reach
	// this channel; those render the plain generic body, exactly like a
	// bare-transition cancellation that carries no reason at all.
	const cancellation =
		template === "order-cancelled"
			? joinLines([
					cancellationRefundLine(data["cancellation"]),
					cancellationLines(data["cancellation"]),
				])
			: null;
	const extra = tracking ?? cancellation;
	const text =
		`${copy.body}\n\nOrder: ${label}\n${totalLabel}: ${total}` +
		(extra !== null ? `\n${extra.text}` : "");
	return {
		subject,
		text,
		html: paragraph(
			`${escapeHtml(copy.body)}<br>Order: ${escapeHtml(label)}<br>${totalLabel}: ${escapeHtml(total)}` +
				(extra !== null ? `<br>${extra.html}` : ""),
		),
	};
}

/**
 * The CUSTOMER-SAFE cancellation-reason copy (PR #64 review blocker). This is an
 * explicit ALLOWLIST, not a label table: only reasons that are safe to state to
 * the buyer map to copy; every other reason — `fraud_suspected` (tips off
 * fraudulent actors, and harms innocent customers on a false positive),
 * `pricing_error` (invites disputes over the merchant's mistake), `other`
 * (free-form catch-all), or any unrecognized value — returns `undefined` and the
 * email renders NO reason line at all (just the generic cancellation body). The
 * full reason + detail remain admin-only, on the order detail page.
 */
export function customerSafeCancellationCopy(reason: string): string | undefined {
	switch (reason) {
		case "customer_request":
			return "at your request";
		case "out_of_stock":
			return "an item was unavailable";
		default:
			return undefined;
	}
}

/** Render the cancellation-reason block for a cancelled email from the
 *  cancellation data the dispatcher passed (`buildOrderEmailData`). Returns null
 *  when the order carried no cancellation (a bare-transition cancellation) OR
 *  when the reason has no customer-safe copy (the allowlist above) — either way
 *  the email degrades to the plain reason-free body. The admin's free-text
 *  `detail` is deliberately NEVER read here: it must not reach the customer
 *  email for ANY reason value (admin-only context). */
function cancellationLines(cancellation: unknown): { text: string; html: string } | null {
	if (cancellation === null || typeof cancellation !== "object") return null;
	const c = cancellation as { reason?: unknown };
	const reason = str(c.reason);
	if (reason === undefined) return null;
	const safeCopy = customerSafeCancellationCopy(reason);
	if (safeCopy === undefined) return null; // not customer-safe ⇒ no reason line
	return { text: `Reason: ${safeCopy}`, html: `Reason: ${escapeHtml(safeCopy)}` };
}

/** The refund a cancellation made (QA T1-4): "A refund of X is on its way …", or
 *  null when the cancellation refunded nothing. Unlike the reason line it is
 *  rendered whatever the reason was — the money is the buyer's, and saying it is
 *  coming reveals nothing about why the order was cancelled. */
function cancellationRefundLine(cancellation: unknown): { text: string; html: string } | null {
	if (cancellation === null || typeof cancellation !== "object") return null;
	const refund = (cancellation as { refund?: unknown }).refund;
	if (refund === null || typeof refund !== "object") return null;
	const r = refund as { amountCents?: unknown; currency?: unknown };
	const amount = formatMoney(r.amountCents, str(r.currency));
	if (amount === "") return null;
	const line = `A refund of ${amount} is on its way to your original payment method.`;
	return { text: line, html: escapeHtml(line) };
}

/** Join optional blocks into one, or null when there are none. */
function joinLines(
	blocks: ReadonlyArray<{ text: string; html: string } | null>,
): { text: string; html: string } | null {
	const present = blocks.filter((b): b is { text: string; html: string } => b !== null);
	if (present.length === 0) return null;
	return {
		text: present.map((b) => b.text).join("\n"),
		html: present.map((b) => b.html).join("<br>"),
	};
}

/** Render the tracking block for a shipped email from the fulfillment data the
 *  dispatcher passed (`buildOrderEmailData`). Returns null when the order carried
 *  no fulfillment (e.g. shipped via the bare transition) so the email degrades to
 *  the plain body rather than showing empty "Carrier:" labels. */
function trackingLines(fulfillment: unknown): { text: string; html: string } | null {
	if (fulfillment === null || typeof fulfillment !== "object") return null;
	const f = fulfillment as {
		carrier?: unknown;
		trackingNumber?: unknown;
		trackingUrl?: unknown;
	};
	const carrier = str(f.carrier);
	const trackingNumber = str(f.trackingNumber);
	if (carrier === undefined && trackingNumber === undefined) return null;
	const trackingUrl = str(f.trackingUrl);
	const textParts: string[] = [];
	const htmlParts: string[] = [];
	if (carrier !== undefined) {
		textParts.push(`Carrier: ${carrier}`);
		htmlParts.push(`Carrier: ${escapeHtml(carrier)}`);
	}
	if (trackingNumber !== undefined) {
		textParts.push(`Tracking: ${trackingNumber}`);
		htmlParts.push(`Tracking: ${escapeHtml(trackingNumber)}`);
	}
	if (trackingUrl !== undefined) {
		textParts.push(`Track your package: ${trackingUrl}`);
		htmlParts.push(`Track your package: ${escapeHtml(trackingUrl)}`);
	}
	return { text: textParts.join("\n"), html: htmlParts.join("<br>") };
}

const ORDER_COPY: Record<
	Exclude<EmailTemplate, "customer-login-link">,
	{ subject: string; body: string }
> = {
	"order-confirmation": {
		subject: "Order confirmed",
		body: "Thanks — we've received your payment and your order is confirmed.",
	},
	"order-processing": { subject: "Order processing", body: "We've started preparing your order." },
	"order-shipped": { subject: "Order shipped", body: "Your order is on its way." },
	"order-delivered": { subject: "Order delivered", body: "Your order has been delivered." },
	"order-completed": { subject: "Order complete", body: "Your order is complete. Thank you!" },
	"order-cancelled": { subject: "Order cancelled", body: "Your order has been cancelled." },
	"order-refunded": { subject: "Order refunded", body: "Your order has been refunded." },
	"order-expired": {
		subject: "Checkout expired",
		body: "Your checkout session expired and the items were released back to stock — you're welcome to try again.",
	},
	// The late-payment notice (`settleOrder`'s auto-refund). The buyer has already
	// had the "checkout expired" email, then saw a charge on their card: this is
	// the one message that reconciles the two, so it names both facts — the
	// payment arrived late, and it is on its way back — plus the provider's
	// settlement window, because "refunded" with no timescale reads as "lost" on
	// day three. Same copy for an expired and a cancelled order: both mean the
	// order could no longer take the money.
	"order-late-payment-refunded": {
		subject: "Payment refunded",
		body: "A payment arrived after your order expired, so we couldn't accept it and have refunded it in full. It can take 5–10 business days to appear on your statement.",
	},
	// A refund announced on its own (QA T1-6): an admin partial refund, or a
	// cancellation's FULL refund on an order that shipped before it could be
	// cancelled. So the body is neutral about HOW MUCH — the figure is on the
	// `Refunded: X` line — and about HOW: a manual (x402) refund goes to a wallet, not
	// "to your original payment method".
	"order-refund-issued": {
		subject: "Refund issued",
		body: "We've issued a refund for your order.",
	},
};

/** The email data's `lines` (built by `buildOrderEmailData`) read back as
 *  `orderLabel` input. Defensive for the same reason `formatMoney` is: the data
 *  crossed the outbox's JSON boundary, so anything that is not an array of
 *  objects contributes nothing — and an order with nothing nameable renders as
 *  "Your order", never as its id. */
function labelLines(lines: unknown): OrderLabelLine[] {
	if (!Array.isArray(lines)) return [];
	return lines.flatMap((line: unknown) => {
		if (line === null || typeof line !== "object") return [];
		const l = line as { title?: unknown; quantity?: unknown };
		return [
			{
				title: str(l.title) ?? null,
				quantity: typeof l.quantity === "number" ? l.quantity : 1,
			},
		];
	});
}

/**
 * The late-payment notice names WHY the order could not take the money. The table
 * copy says "expired" — by far the common case (a pay page left open past the
 * hold) — and a cancelled or (historical) failed order gets its own sentence:
 * telling a buyer whose order a merchant cancelled that it "expired" would be a
 * small lie about the one thing this email exists to explain. `state` is the
 * order's state when the notice was enqueued (`buildOrderEmailData`).
 */
function latePaymentCopyFor(
	template: EmailTemplate,
	state: string | undefined,
): { subject: string; body: string } | null {
	if (template !== "order-late-payment-refunded") return null;
	const subject = ORDER_COPY["order-late-payment-refunded"].subject;
	const tail =
		"so we couldn't accept it and have refunded it in full. It can take 5–10 business days to appear on your statement.";
	if (state === "cancelled") {
		return { subject, body: `A payment arrived after your order was cancelled, ${tail}` };
	}
	if (state === "failed") {
		// A historical `failed` order (ADR-0022): it never completed, and the buyer
		// was told so — the late payment is money for an order that no longer exists.
		return { subject, body: `A payment arrived for an order that had already failed, ${tail}` };
	}
	return null;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Minor-unit integer → major-unit display. NEVER float math on the stored value.
 *
 * `unknown` ON PURPOSE, not a missed `Cents`: the argument comes out of the
 * outbox row's loose `data` record, which crossed a JSON boundary — the brand
 * cannot survive that trip, so the check has to happen here, and it is a FULL
 * one. A non-integer (a float that "looks like" a price, a NaN from a bad parse)
 * renders NOTHING rather than a plausible-looking wrong amount — the same
 * fail-closed choice the missing-currency arm already made.
 *
 * THE SIGN IS SPLIT OFF FIRST (INC-C5 review, A8). `Math.floor` rounds toward
 * -∞ and `%` keeps the dividend's sign, so the naive split rendered -550 as
 * "-6.-50" — not a price, in an email a customer reads. Formatting the
 * MAGNITUDE and re-attaching the sign is correct on both sides of zero.
 */
function formatMoney(cents: unknown, currency: string | undefined): string {
	if (typeof cents !== "number" || !Number.isSafeInteger(cents) || currency === undefined) {
		return "";
	}
	const sign = cents < 0 ? "-" : "";
	const magnitude = Math.abs(cents);
	const major = Math.floor(magnitude / 100);
	const minor = String(magnitude % 100).padStart(2, "0");
	return `${sign}${major}.${minor} ${currency}`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function paragraph(html: string): string {
	return `<p>${html}</p>`;
}
