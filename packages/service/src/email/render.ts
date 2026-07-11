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
	const text = `${copy.body}\n\nOrder: ${orderId}\nTotal: ${total}`;
	return {
		subject,
		text,
		html: paragraph(
			`${escapeHtml(copy.body)}<br>Order: ${escapeHtml(orderId)}<br>Total: ${escapeHtml(total)}`,
		),
	};
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
