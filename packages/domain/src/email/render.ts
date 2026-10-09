import { orderLabel, type OrderLabelLine } from "../orders/order-label.js";
import { orderNumber } from "../orders/order-number.js";
import { orderTotalLabel } from "../orders/order-total-label.js";
import type { EmailTemplate } from "../ports/email-sender.js";

export interface RenderedEmail {
	subject: string;
	text: string;
	html: string;
}

/**
 * What the CALLER supplies to a render, beyond the template's own data (QA U-3).
 *
 * Nothing here is read from a store: the plugin's email sender resolves it from
 * its settings and passes it in, so rendering stays pure.
 */
export interface EmailRenderContext {
	/**
	 * Integer minor units + an ISO currency code → display money ("$100.00",
	 * "₹1,234.50"), or `null` when the value cannot be formatted.
	 *
	 * INJECTED, NOT IMPLEMENTED HERE. Formatting is presentation, not domain
	 * (`@otta-sh/admin-presentation`'s `formatMoney` says so), and the email must
	 * format money exactly as the storefront does — so the plugin passes the
	 * storefront's own formatter, at the storefront's locale. Called only with a
	 * safe integer and a non-empty currency; a negative amount is never passed
	 * (the renderer places the sign itself).
	 */
	formatMoney: (minorUnits: number, currency: string) => string | null;
	/** The store's name, for the sign-in email. Plain text; escaped here. */
	storeName?: string | undefined;
	/**
	 * The absolute URL of THIS order's page on the storefront — the same page the
	 * shopper lands on after checkout. A bearer link (the page is readable by
	 * whoever holds the URL), so it goes only to the order's own recipient.
	 * Absent when the store's public URL is not configured: then no link at all.
	 */
	orderPageUrl?: string | undefined;
	/** The storefront's locale (BCP 47), declared on the HTML part's wrapper so a
	 *  client picks the right hyphenation, voice and font fallbacks. */
	locale?: string | undefined;
}

/** What an uncalculated shipping or tax row says — the storefront's own
 *  `NOT_CALCULATED_LABEL` (the plugin pins that the two are equal). A store
 *  that never priced delivery did not make it free: never "$0.00". */
export const EMAIL_NOT_CALCULATED_LABEL = "Not calculated";

/** A rendered block: the same content as plain text and as HTML. */
interface Block {
	text: string;
	html: string;
}

/**
 * Render an email from a template + explicit data (Phase 5 §6). Plain-text +
 * HTML pair, interpolated (no concatenation of user data into markup beyond
 * escaping) so the templates stay i18n-ready. No template reaches back into a
 * store — it renders only what the dispatcher passed it, plus the caller's
 * {@link EmailRenderContext}.
 *
 * EVERY VALUE FROM DATA IS UNTRUSTED. Product titles come from the CMS, the
 * address and coupon code from a shopper's form. In HTML each is escaped; in
 * plain text each single-line value is folded onto one line, so a CR/LF in a
 * title cannot forge a "View your order:" line of its own.
 */
export function renderEmail(
	template: EmailTemplate,
	data: Record<string, unknown>,
	context: EmailRenderContext,
): RenderedEmail {
	if (template === "customer-login-link") return renderLoginLink(data, context);

	const money = moneyFormatter(context);
	// The order is named by WHAT WAS BOUGHT (`orderLabel`) and by its short NUMBER
	// (`orderNumber`, "#3F9A2" — ADR-0033), never by the whole id: the recipient is
	// the buyer, and a UUID names nothing they bought. The number is what tells two
	// orders of the same product apart in an inbox. The id still travels in
	// `data.orderId` — the dispatcher keys on it, and the caller builds the order
	// page link from it.
	const label = orderLabel(labelLines(data["lines"]));
	const number = numberOf(data["orderId"]);
	const copy = latePaymentCopyFor(template, str(data["state"])) ?? ORDER_COPY[template];
	const subject = subjectLine(copy.subject, number, label);
	// A refund email states its OWN figure first (`noticeAmountCents`, the refunded
	// money): a late capture or a partial refund differs from the order total,
	// which the summary below states under its own name. The ONE "amount refunded"
	// path: notices (late payment, partial refund) and the `refunded` state email
	// alike (ADR-0026).
	const refunded =
		data["noticeAmountCents"] !== undefined
			? money(data["noticeAmountCents"], str(data["noticeCurrency"]))
			: null;
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
					cancellationRefundLine(data["cancellation"], money),
					cancellationLines(data["cancellation"]),
				])
			: null;

	const sections: Array<Block | null> = [
		{ text: copy.body, html: paragraph(escapeHtml(copy.body)) },
		refunded === null
			? null
			: {
					text: `Refunded: ${refunded}`,
					html: paragraph(`<strong>Refunded: ${escapeHtml(refunded)}</strong>`),
				},
		asParagraph(tracking ?? cancellation),
		orderLine(number, label),
		lineItems(data["lines"], str(data["currency"]), money),
		totalsBlock(data, money, refunded !== null),
		DELIVERY_TEMPLATES.has(template) ? addressBlock(data["shippingAddress"]) : null,
		orderLink(context.orderPageUrl),
		signOff(context.storeName),
	];
	const present = sections.filter((s): s is Block => s !== null);
	return {
		subject,
		text: present.map((s) => s.text).join("\n\n"),
		html: withLang(present.map((s) => s.html).join(""), context.locale),
	};
}

/**
 * The sign-in email (QA U-3): it names the store, gives the link a clear label
 * (a raw URL alone reads like spam and wraps badly), keeps the URL as the
 * plain-text part's link and as the HTML part's copy-paste fallback, and states
 * the real lifetime — `expiresInMinutes`, which the sender derives from the
 * challenge TTL the store enforces.
 */
function renderLoginLink(
	data: Record<string, unknown>,
	context: EmailRenderContext,
): RenderedEmail {
	const loginUrl = str(data["loginUrl"]);
	const store = context.storeName !== undefined ? oneLine(context.storeName) : "";
	const subject = store.length > 0 ? `Sign in to ${store}` : "Your sign-in link";
	const action = store.length > 0 ? `Sign in to ${store}` : "Sign in";
	const minutes = data["expiresInMinutes"];
	const lifetime =
		typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes > 0
			? `It works once and expires in ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}.`
			: "It works once.";
	const intro = `${store.length > 0 ? `Use the link below to sign in to ${store}.` : "Use the link below to sign in."} ${lifetime}`;
	const ignore = "If you didn't ask to sign in, you can ignore this email.";
	if (loginUrl === undefined) {
		return {
			subject,
			text: `${intro}\n\n${ignore}`,
			html: withLang(paragraph(escapeHtml(intro)) + paragraph(escapeHtml(ignore)), context.locale),
		};
	}
	// The href is escaped exactly like text: the URL is built from operator config
	// and a token, and neither is markup. (Anchor + escaping adapted from #325 by
	// @stephanedemotte.)
	const href = escapeHtml(loginUrl);
	return {
		subject,
		text: `${intro}\n\n${action}: ${loginUrl}\n\n${ignore}`,
		html: withLang(
			paragraph(escapeHtml(intro)) +
				paragraph(`<a href="${href}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a>`) +
				paragraph(`If the link doesn't work, copy this link into your browser:<br>${href}`) +
				paragraph(escapeHtml(ignore)),
			context.locale,
		),
	};
}

/**
 * The sign-in link as a BUTTON (QA2 U-3): a padded, filled, bold link, so the one
 * thing the email asks for is the one thing it shows. Inline styles only — mail
 * clients drop `<style>` blocks — and the URL stays below it as the copy-paste
 * fallback.
 */
const BUTTON_STYLE =
	"display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600";

/** What a line with no usable title is called. */
const UNTITLED_LINE = "Item";

/** Money as the renderer uses it: data's loose values in, a display string or
 *  `null` out. Validates what crossed the outbox's JSON boundary — a non-integer
 *  or a missing currency renders NOTHING rather than a plausible wrong amount —
 *  and places the sign itself, so the formatter only ever sees a magnitude. */
type Money = (minorUnits: unknown, currency: string | undefined) => string | null;

function moneyFormatter(context: EmailRenderContext): Money {
	return (minorUnits, currency) => {
		if (
			typeof minorUnits !== "number" ||
			!Number.isSafeInteger(minorUnits) ||
			currency === undefined ||
			currency.length === 0
		) {
			return null;
		}
		const formatted = context.formatMoney(Math.abs(minorUnits), currency);
		if (formatted === null || formatted.length === 0) return null;
		return minorUnits < 0 ? `−${formatted}` : formatted;
	};
}

/** The line snapshot: "Otta Tee × 2 — $30.00" (unit price × quantity, from the
 *  ORDER's lines — `buildOrderEmailData` copies them off the order, never the
 *  live product). Null when there are no readable lines. */
function lineItems(lines: unknown, currency: string | undefined, money: Money): Block | null {
	if (!Array.isArray(lines)) return null;
	const rows = lines.flatMap((line: unknown) => {
		if (line === null || typeof line !== "object") return [];
		const l = line as { title?: unknown; quantity?: unknown; unitPriceCents?: unknown };
		// A blank title still names a line the buyer paid for: "Item", never a
		// silently shorter list.
		const title = oneLine(str(l.title) ?? "") || UNTITLED_LINE;
		const quantity = l.quantity;
		if (typeof quantity !== "number" || !Number.isSafeInteger(quantity)) return [];
		const unit = l.unitPriceCents;
		const lineTotal =
			typeof unit === "number" && Number.isSafeInteger(unit * quantity)
				? money(unit * quantity, currency)
				: null;
		return [{ title, quantity, lineTotal }];
	});
	if (rows.length === 0) return null;
	return {
		text: rows
			.map(
				(r) =>
					`${r.title} × ${String(r.quantity)}${r.lineTotal === null ? "" : ` — ${r.lineTotal}`}`,
			)
			.join("\n"),
		html: table(
			rows.map((r) => [
				`${escapeHtml(r.title)} × ${String(r.quantity)}`,
				r.lineTotal === null ? "" : escapeHtml(r.lineTotal),
			]),
		),
	};
}

/**
 * Subtotal, discount (with its coupon code), shipping, tax and total, AS THE
 * ORDER RECORDED THEM — the order page's own rows (`pages/orders/[orderId].astro`
 * over `buildCheckoutTotals` / `orderTotalsFlags`), with its labels and sign:
 *  - "Discount · CODE" when a coupon was applied (a coupon that took nothing off
 *    is a real "$0.00"), "Discount" for a discount with no code, and the page's
 *    "No coupon applied" when there is neither. The amount is UNSIGNED, as on
 *    the page — the row's name says it comes off.
 *  - a "Rounding" row, SIGNED (`−KWD 0.003`), only for an order whose total was
 *    rounded to its currency's payment increment (ADR-0033's amendment).
 *  - shipping and tax read {@link EMAIL_NOT_CALCULATED_LABEL} whenever their flag
 *    (`shippingCalculated` / `taxCalculated`, derived exactly as the page's
 *    `orderTotalsFlags`) is not set — whatever the amount, as on the page. (An
 *    amount without a flag cannot be created: shipping is only priced with a
 *    method, tax only with a zone.) A calculated zero is money.
 *  - the total is labelled by `orderTotalLabel`, the rule the order pages use:
 *    "Paid" for every state an order reaches only after its payment was
 *    captured (refunded included — the refund is said separately), "Total"
 *    otherwise. ONE DELIBERATE DIVERGENCE: an email that leads with a
 *    "Refunded: X" figure labels it "Order total", so the order's total can
 *    never be read as the money coming back.
 * A row whose amount cannot be formatted is left out rather than shown wrong.
 */
function totalsBlock(data: Record<string, unknown>, money: Money, isRefund: boolean): Block | null {
	const currency = str(data["currency"]);
	const rows: Array<[string, string]> = [];
	const push = (label: string, value: string | null) => {
		if (value !== null) rows.push([label, value]);
	};
	push("Subtotal", money(data["subtotalCents"], currency));
	const coupon = str(data["appliedCouponCode"]);
	const discount = data["discountCents"];
	if (coupon !== undefined || (typeof discount === "number" && discount > 0)) {
		const name = coupon !== undefined ? `Discount · ${oneLine(coupon)}` : "Discount";
		push(name, money(discount, currency));
	} else {
		push("Discount", NO_COUPON_LABEL);
	}
	push("Shipping", calculated(data["shippingCents"], data["shippingCalculated"], currency, money));
	push(
		data["taxIncluded"] === true ? "Tax (included in prices)" : "Tax",
		calculated(data["taxCents"], data["taxCalculated"], currency, money),
	);
	// ADR-0033's amendment: the payment rounding, signed, only when the order has one.
	const rounding = data["roundingCents"];
	if (typeof rounding === "number" && rounding !== 0) {
		const magnitude = money(Math.abs(rounding), currency);
		if (magnitude !== null) push("Rounding", `${rounding < 0 ? "−" : "+"}${magnitude}`);
	}
	const totalLabel = isRefund ? "Order total" : orderTotalLabel(str(data["state"]) ?? "");
	push(totalLabel, money(data["totalCents"], currency));
	// A state email sent after a partial refund (QA round 2): "Paid: $10.00" alone
	// read as if all of it were still held. The ledger's refunded figure follows it.
	if (!isRefund && data["refundedSoFarCents"] !== undefined) {
		push("Refunded so far", money(data["refundedSoFarCents"], currency));
	}
	if (rows.length === 0) return null;
	return {
		text: rows.map(([label, value]) => `${label}: ${value}`).join("\n"),
		html: table(rows.map(([label, value]) => [escapeHtml(label), escapeHtml(value)])),
	};
}

/** The order page's discount row when no coupon was applied (its `fallback`). */
const NO_COUPON_LABEL = "No coupon applied";

function calculated(
	amount: unknown,
	flag: unknown,
	currency: string | undefined,
	money: Money,
): string | null {
	return flag === true ? money(amount, currency) : EMAIL_NOT_CALCULATED_LABEL;
}

/**
 * The templates that show the ship-to: the ones where a delivery is still live.
 * On an expired, cancelled, refunded or completed order nothing is (still) going
 * to that address, and printing it would read like a promise that something is.
 */
const DELIVERY_TEMPLATES: ReadonlySet<EmailTemplate> = new Set<EmailTemplate>([
	"order-confirmation",
	"order-processing",
	"order-shipped",
	"order-delivered",
]);

/** The ship-to snapshot, or null when the order has none (a digital-only order,
 *  or one placed before addresses were captured). Contact fields are not shown. */
function addressBlock(address: unknown): Block | null {
	if (address === null || typeof address !== "object") return null;
	const a = address as Record<string, unknown>;
	const field = (key: string) => oneLine(str(a[key]) ?? "");
	const cityLine = [
		[field("city"), field("region")].filter((p) => p.length > 0).join(", "),
		field("postalCode"),
	]
		.filter((p) => p.length > 0)
		.join(" ");
	const lines = [field("name"), field("line1"), field("line2"), cityLine, field("country")].filter(
		(l) => l.length > 0,
	);
	if (lines.length === 0) return null;
	return {
		text: `Delivery address:\n${lines.join("\n")}`,
		html: paragraph(`Delivery address:<br>${lines.map(escapeHtml).join("<br>")}`),
	};
}

/** The order page link, or null when the caller has no storefront URL. */
function orderLink(url: string | undefined): Block | null {
	if (url === undefined || url.length === 0) return null;
	return {
		text: `View your order: ${url}`,
		html: paragraph(`<a href="${escapeHtml(url)}">View your order</a>`),
	};
}

/** "— <store>", the order email's last line, or null when the store has no
 *  display name. */
function signOff(storeName: string | undefined): Block | null {
	const store = storeName !== undefined ? oneLine(storeName) : "";
	if (store.length === 0) return null;
	return { text: `— ${store}`, html: paragraph(`— ${escapeHtml(store)}`) };
}

/** The HTML part in one element that declares its language, or as-is when the
 *  caller passed no locale. */
function withLang(html: string, locale: string | undefined): string {
	if (locale === undefined || locale.length === 0) return html;
	return `<div lang="${escapeHtml(locale)}">${html}</div>`;
}

function asParagraph(block: Block | null): Block | null {
	return block === null ? null : { text: block.text, html: paragraph(block.html) };
}

/** Two-column rows of ALREADY-ESCAPED cells. */
function table(rows: ReadonlyArray<readonly [string, string]>): string {
	const body = rows
		.map(
			([left, right]) =>
				`<tr><td style="padding:2px 16px 2px 0">${left}</td><td style="padding:2px 0;text-align:right">${right}</td></tr>`,
		)
		.join("");
	return `<table role="presentation" cellpadding="0" cellspacing="0">${body}</table>`;
}

/** C0/C1 controls (CR/LF among them) — folded to a space. */
// oxlint-disable-next-line no-control-regex -- matching control characters IS the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
/** Invisible format characters (zero-width, bidi overrides, BOM) — removed: a
 *  right-to-left override would visually reorder a line. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/** One untrusted value on one line, for the plain-text part. */
function oneLine(value: string): string {
	return value.replace(INVISIBLE, "").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
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
function cancellationLines(cancellation: unknown): Block | null {
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
function cancellationRefundLine(cancellation: unknown, money: Money): Block | null {
	if (cancellation === null || typeof cancellation !== "object") return null;
	const refund = (cancellation as { refund?: unknown }).refund;
	if (refund === null || typeof refund !== "object") return null;
	const r = refund as { amountCents?: unknown; currency?: unknown };
	const amount = money(r.amountCents, str(r.currency));
	if (amount === null) return null;
	const line = `A refund of ${amount} is on its way to your original payment method.`;
	return { text: line, html: escapeHtml(line) };
}

/** Join optional blocks into one, or null when there are none. */
function joinLines(blocks: ReadonlyArray<Block | null>): Block | null {
	const present = blocks.filter((b): b is Block => b !== null);
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
function trackingLines(fulfillment: unknown): Block | null {
	if (fulfillment === null || typeof fulfillment !== "object") return null;
	const f = fulfillment as {
		carrier?: unknown;
		trackingNumber?: unknown;
		trackingUrl?: unknown;
	};
	// Admin free text: folded onto one line, so a CR/LF in a carrier name cannot
	// forge a line of its own in the plain-text part.
	const folded = (value: unknown) => {
		const text = oneLine(str(value) ?? "");
		return text.length > 0 ? text : undefined;
	};
	const carrier = folded(f.carrier);
	const trackingNumber = folded(f.trackingNumber);
	if (carrier === undefined && trackingNumber === undefined) return null;
	const trackingUrl = folded(f.trackingUrl);
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
	// `Refunded: X` line — and about HOW: a manual refund may go anywhere, not
	// "to your original payment method".
	"order-refund-issued": {
		subject: "Refund issued",
		body: "We've issued a refund for your order.",
	},
};

/**
 * The order's number from the email data's `orderId`, or `null` when the data
 * carries none (it crossed the outbox's JSON boundary, so it is read defensively —
 * an email without a number still names the order by its products). `orderNumber`
 * runs on the RAW id, exactly as on the page and the console, so the three can
 * never disagree; only its OUTPUT is then folded onto one line, like any other
 * value bound for a subject (a real id has nothing to fold).
 */
function numberOf(orderId: unknown): string | null {
	const id = str(orderId);
	if (id === undefined || id.length === 0) return null;
	const number = oneLine(orderNumber(id));
	return number.length > 1 ? number : null;
}

/** "Order confirmed #3F9A2 — Otta Tee": the template's subject, the order's number,
 *  then what was bought. English word order, fixed here as the rest of the copy is;
 *  the composition lives in this one function, which is the seam a translated
 *  subject table would replace. */
function subjectLine(subject: string, number: string | null, label: string): string {
	return number === null ? `${subject} — ${label}` : `${subject} ${number} — ${label}`;
}

/** "Order #3F9A2: Otta Tee" — the body's line naming the order. */
function orderLine(number: string | null, label: string): Block {
	if (number === null) {
		return { text: `Order: ${label}`, html: paragraph(`<strong>${escapeHtml(label)}</strong>`) };
	}
	return {
		text: `Order ${number}: ${label}`,
		html: paragraph(`<strong>Order ${escapeHtml(number)}</strong><br>${escapeHtml(label)}`),
	};
}

/** The email data's `lines` (built by `buildOrderEmailData`) read back as
 *  `orderLabel` input. Defensive for the same reason the money formatter is: the data
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
