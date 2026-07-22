import type { EmailTemplate } from "@urumi/domain";

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
		const link = str(data["loginUrl"]) ?? str(data["challengeId"]) ?? "";
		const subject = "Your sign-in link";
		const text = `Click to sign in: ${link}\n\nThis link is single-use and expires shortly. If you didn't request it, you can ignore this email.`;
		return { subject, text, html: paragraph(`Click to sign in: ${escapeHtml(link)}`) };
	}

	const orderId = str(data["orderId"]) ?? "";
	const total = formatMoney(data["totalCents"], str(data["currency"]));
	const copy = ORDER_COPY[template];
	const subject = `${copy.subject} — order ${orderId}`;
	// The shipped email carries the recorded tracking (admin-UX Increment 1) so it
	// is no longer an empty "on its way" — rendered only when the order was
	// fulfilled and the data carries it (any other template ignores fulfillment).
	const tracking = template === "order-shipped" ? trackingLines(data["fulfillment"]) : null;
	const text =
		`${copy.body}\n\nOrder: ${orderId}\nTotal: ${total}` +
		(tracking !== null ? `\n${tracking.text}` : "");
	return {
		subject,
		text,
		html: paragraph(
			`${escapeHtml(copy.body)}<br>Order: ${escapeHtml(orderId)}<br>Total: ${escapeHtml(total)}` +
				(tracking !== null ? `<br>${tracking.html}` : ""),
		),
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
};

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function formatMoney(cents: unknown, currency: string | undefined): string {
	if (typeof cents !== "number" || currency === undefined) return "";
	// Minor-unit integer → major-unit display; NEVER float math on the stored value.
	const major = Math.floor(cents / 100);
	const minor = String(cents % 100).padStart(2, "0");
	return `${major}.${minor} ${currency}`;
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
