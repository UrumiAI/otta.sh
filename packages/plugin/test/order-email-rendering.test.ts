/**
 * QA U-3, end to end through the real email adapter: what an order email and a
 * sign-in email look like on the wire, rendered with the STOREFRONT's money
 * formatter and linked to the storefront's order page.
 *
 * The domain suite (`render-order-details.test.ts`) pins the layout against a
 * stub formatter; this file pins the wiring the domain cannot see:
 *  - money is the storefront's (`formatMoney` at the storefront locale): "$100.00",
 *    "₹1,234.50" — never "100.00 USD";
 *  - the order link is `<store origin>/orders/<id>`, the same page the shopper
 *    lands on after checkout, built from the operator's configured sign-in page
 *    URL — never from a request;
 *  - the store's name comes from the "Store display name" setting;
 *  - the message handed to the host's `ctx.email` is exactly EmDash's
 *    `EmailMessage` (to, subject, text, html) — no `from` (the provider owns it,
 *    ADR-0031) — and nothing goes out over `ctx.http`.
 */
import { EMAIL_NOT_CALCULATED_LABEL, type EmailTemplate } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { STORE_DISPLAY_NAME_KEY } from "../src/admin/settings-form.js";
import {
	CtxEmailSender,
	makeEmailSender,
	makeLoginEmailSender,
} from "../src/email/ctx-email-sender.js";
import {
	orderPageUrl,
	storefrontEmailMoney,
	storefrontOriginOf,
} from "../src/email/email-render-context.js";
import { STOREFRONT_LOCALE } from "../src/index.js";
import { NOT_CALCULATED_LABEL } from "../src/storefront/checkout-view-model.js";
import { isSavableLoginLinkUrl, LOGIN_LINK_URL_KEY } from "../src/storefront/login-link.js";
import type { EmailMessage, PluginContext } from "../src/types.js";

type Sent = EmailMessage & { html: string };

function makeCtx(seed: Record<string, unknown> = {}): { ctx: PluginContext; sent: Sent[] } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const sent: Sent[] = [];
	const ctx: PluginContext = {
		http: {
			// Email never goes over `ctx.http` (ADR-0031).
			fetch: () => Promise.reject(new Error("email must not use ctx.http")),
		},
		email: {
			send: async (message) => {
				sent.push({ ...message, html: message.html ?? "" });
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				kv.set(k, v);
			},
			async delete(k: string): Promise<boolean> {
				return kv.delete(k);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
	};
	return { ctx, sent };
}

const ORDER_ID = "0b6f1c2e-9a4d-4e57-8f1a-3c2d1e0f9a8b";
const ORDER_URL = `https://shop.example/orders/${ORDER_ID}`;

/** The shape `buildOrderEmailData` produces: one $100 mug, nothing else priced. */
const usdOrder = {
	orderId: ORDER_ID,
	state: "paid",
	currency: "USD",
	subtotalCents: 10000,
	discountCents: 0,
	shippingCents: 0,
	taxCents: 0,
	totalCents: 10000,
	appliedCouponCode: null,
	shippingCalculated: false,
	taxCalculated: false,
	lines: [{ sku: "MUG", title: "Otta Mug", quantity: 1, unitPriceCents: 10000 }],
	shippingAddress: null,
};

const ORDER_TEMPLATES: EmailTemplate[] = [
	"order-confirmation",
	"order-processing",
	"order-shipped",
	"order-delivered",
	"order-completed",
	"order-cancelled",
	"order-refunded",
	"order-expired",
	"order-late-payment-refunded",
	"order-refund-issued",
];

function sender(ctx: PluginContext, extra: { storeName?: string; storefrontOrigin?: string } = {}) {
	return new CtxEmailSender({
		email: ctx.email!,
		storefrontOrigin: "https://shop.example",
		...extra,
	});
}

describe("order emails on the wire", () => {
	test.each(ORDER_TEMPLATES)(
		"%s: storefront money, the line, and the order link",
		async (template) => {
			const { ctx, sent } = makeCtx();
			await sender(ctx).send({
				to: "buyer@example.com" as never,
				template,
				data: { ...usdOrder, noticeAmountCents: 2500, noticeCurrency: "USD" },
				idempotencyKey: "row-1",
			});
			const [mail] = sent;
			expect(Object.keys(mail ?? {}).toSorted()).toEqual(
				["html", "subject", "text", "to"].toSorted(),
			);
			expect(mail?.to).toBe("buyer@example.com");
			expect(mail?.text).toContain("Otta Mug × 1 — $100.00");
			expect(mail?.text).toContain("Order total: $100.00");
			expect(mail?.text).toContain(`Shipping: ${NOT_CALCULATED_LABEL}`);
			expect(mail?.text).not.toContain("USD");
			expect(mail?.text).toContain(`View your order: ${ORDER_URL}`);
			expect(mail?.html).toContain(`<a href="${ORDER_URL}">View your order</a>`);
			expect(mail?.subject).not.toContain(ORDER_ID);
		},
	);

	test("a refund email's own figure is storefront money too", async () => {
		const { ctx, sent } = makeCtx();
		await sender(ctx).send({
			to: "buyer@example.com" as never,
			template: "order-refund-issued",
			data: { ...usdOrder, noticeAmountCents: 2500, noticeCurrency: "USD" },
			idempotencyKey: "row-2",
		});
		expect(sent[0]?.text).toContain("Refunded: $25.00");
	});

	test("a non-USD order is formatted for its own currency (INR)", async () => {
		const { ctx, sent } = makeCtx();
		await sender(ctx).send({
			to: "buyer@example.com" as never,
			template: "order-confirmation",
			data: {
				...usdOrder,
				currency: "INR",
				subtotalCents: 123450,
				totalCents: 145671,
				taxCents: 22221,
				taxCalculated: true,
				lines: [{ sku: "BEANS", title: "Goa Beans", quantity: 3, unitPriceCents: 41150 }],
			},
			idempotencyKey: "row-3",
		});
		expect(sent[0]?.text).toContain("Goa Beans × 3 — ₹1,234.50");
		expect(sent[0]?.text).toContain("Tax: ₹222.21");
		expect(sent[0]?.text).toContain("Paid: ₹1,456.71");
		expect(sent[0]?.text).not.toContain("INR");
	});

	test("a zero-decimal currency keeps its own minor units (JPY)", () => {
		expect(storefrontEmailMoney(1500, "JPY")).toBe("¥1,500");
		expect(storefrontEmailMoney(10000, "USD")).toBe("$100.00");
		expect(storefrontEmailMoney(5, "USD")).toBe("$0.05");
	});

	test("an unformattable currency renders no amount, never raw minor units", () => {
		expect(storefrontEmailMoney(10000, "NOT-A-CODE")).toBeNull();
	});

	test("with no storefront URL configured there is no link", async () => {
		const { ctx, sent } = makeCtx();
		await new CtxEmailSender({ email: ctx.email! }).send({
			to: "buyer@example.com" as never,
			template: "order-confirmation",
			data: usdOrder,
			idempotencyKey: "row-4",
		});
		expect(sent[0]?.text).not.toContain("View your order");
		expect(sent[0]?.html).not.toContain("<a ");
	});

	test("the HTML part declares the storefront's locale, and the store signs off", async () => {
		const { ctx, sent } = makeCtx();
		await sender(ctx, { storeName: "Goa Coffee" }).send({
			to: "buyer@example.com" as never,
			template: "order-confirmation",
			data: usdOrder,
			idempotencyKey: "row-7",
		});
		expect(STOREFRONT_LOCALE).toBe("en");
		expect(sent[0]?.html.startsWith(`<div lang="${STOREFRONT_LOCALE}">`)).toBe(true);
		expect(sent[0]?.text.endsWith("— Goa Coffee")).toBe(true);
	});

	test("the email's 'Not calculated' is the storefront's own label", () => {
		expect(EMAIL_NOT_CALCULATED_LABEL).toBe(NOT_CALCULATED_LABEL);
	});
});

describe("the storefront origin a bearer link may use", () => {
	test("https: the origin, whatever path the sign-in page has", () => {
		expect(storefrontOriginOf("https://shop.example/account/verify")).toBe("https://shop.example");
		expect(storefrontOriginOf("https://shop.example:8443/x/account/verify")).toBe(
			"https://shop.example:8443",
		);
	});

	test("http: only on this machine — a bearer link must not travel in clear text", () => {
		expect(storefrontOriginOf("http://shop.example/account/verify")).toBeUndefined();
		expect(storefrontOriginOf("http://localhost:4700/account/verify")).toBe(
			"http://localhost:4700",
		);
		expect(storefrontOriginOf("http://127.0.0.1:4700/account/verify")).toBe(
			"http://127.0.0.1:4700",
		);
	});

	test("anything else: no origin, so no link", () => {
		expect(storefrontOriginOf(undefined)).toBeUndefined();
		expect(storefrontOriginOf("javascript:alert(1)")).toBeUndefined();
		expect(storefrontOriginOf("https://user:pw@shop.example/account/verify")).toBeUndefined();
	});

	test("an order link exists exactly when Settings would save the sign-in page — one https-or-loopback rule", () => {
		for (const url of [
			"https://shop.example/account/verify",
			"http://shop.example/account/verify",
			"http://localhost:4700/account/verify",
			"http://127.0.0.1:4700/account/verify",
			"http://[::1]:4700/account/verify",
			"http://localhost.example/account/verify",
			"http://127.0.0.2/account/verify",
			"ftp://shop.example/account/verify",
			"https://user:pw@shop.example/account/verify",
			"not a url",
		]) {
			expect(storefrontOriginOf(url) !== undefined, url).toBe(isSavableLoginLinkUrl(url));
		}
	});
});

describe("the order page URL", () => {
	test("is the storefront's /orders/<id> — the page checkout sends the shopper to", () => {
		expect(orderPageUrl("https://shop.example", ORDER_ID)).toBe(ORDER_URL);
	});

	test("encodes the id exactly as the site does (encodeURIComponent)", () => {
		expect(orderPageUrl("https://shop.example", "a/b?c")).toBe(
			"https://shop.example/orders/a%2Fb%3Fc",
		);
	});
});

describe("makeEmailSender reads the store's name and public URL from Settings", () => {
	test("order emails link to the origin of the configured sign-in page", async () => {
		const { ctx, sent } = makeCtx({
			[LOGIN_LINK_URL_KEY]: "https://shop.example/account/verify",
		});
		const s = await makeEmailSender(ctx);
		await s?.send({
			to: "buyer@example.com" as never,
			template: "order-confirmation",
			data: usdOrder,
			idempotencyKey: "row-5",
		});
		expect(sent[0]?.text).toContain(`View your order: ${ORDER_URL}`);
	});

	test("an invalid stored sign-in URL gives no link at all (never a guess)", async () => {
		const { ctx, sent } = makeCtx({ [LOGIN_LINK_URL_KEY]: "javascript:alert(1)" });
		const s = await makeEmailSender(ctx);
		await s?.send({
			to: "buyer@example.com" as never,
			template: "order-confirmation",
			data: usdOrder,
			idempotencyKey: "row-6",
		});
		expect(sent[0]?.text).not.toContain("View your order");
		expect(sent[0]?.html).not.toContain("javascript:");
	});

	test("the sign-in email names the store from 'Store display name'", async () => {
		const { ctx, sent } = makeCtx({ [STORE_DISPLAY_NAME_KEY]: "Goa Coffee" });
		const s = await makeLoginEmailSender(ctx);
		await s?.send({
			to: "buyer@example.com" as never,
			template: "customer-login-link",
			data: {
				loginUrl: "https://shop.example/account/verify?challenge=c&token=t",
				expiresInMinutes: 15,
			},
			idempotencyKey: "login:c",
		});
		expect(sent[0]?.subject).toBe("Sign in to Goa Coffee");
		expect(sent[0]?.text).toContain("expires in 15 minutes");
		expect(sent[0]?.html).toContain(">Sign in to Goa Coffee</a>");
		expect(sent[0]?.to).toBe("buyer@example.com");
	});

	test("with no 'Store display name' saved, the EmDash site name signs the email", async () => {
		const { ctx, sent } = makeCtx();
		const s = await makeEmailSender({
			...ctx,
			site: { name: "Goa Coffee", url: "https://shop.example", locale: "en" },
		});
		await s?.send({
			to: "buyer@example.com" as never,
			template: "customer-login-link",
			data: {
				loginUrl: "https://shop.example/account/verify?challenge=c&token=t",
				expiresInMinutes: 15,
			},
			idempotencyKey: "login:c",
		});
		expect(sent[0]?.subject).toBe("Sign in to Goa Coffee");
	});

	test("the saved 'Store display name' wins over the site name", async () => {
		const { ctx, sent } = makeCtx({ [STORE_DISPLAY_NAME_KEY]: "Tambdi Mati" });
		const s = await makeEmailSender({
			...ctx,
			site: { name: "Goa Coffee", url: "https://shop.example", locale: "en" },
		});
		await s?.send({
			to: "buyer@example.com" as never,
			template: "customer-login-link",
			data: {
				loginUrl: "https://shop.example/account/verify?challenge=c&token=t",
				expiresInMinutes: 15,
			},
			idempotencyKey: "login:c",
		});
		expect(sent[0]?.subject).toBe("Sign in to Tambdi Mati");
	});

	test("no EmDash email provider (ctx.email absent) ⇒ no sender at all, no kv read", async () => {
		const { ctx } = makeCtx({ [STORE_DISPLAY_NAME_KEY]: "Goa Coffee" });
		const { email: _none, ...noEmail } = ctx;
		let reads = 0;
		const counted: PluginContext = {
			...noEmail,
			kv: {
				...noEmail.kv,
				get: async <T>(key: string) => {
					reads += 1;
					return noEmail.kv.get<T>(key);
				},
			},
		};
		expect(await makeEmailSender(counted)).toBeUndefined();
		expect(await makeLoginEmailSender(counted)).toBeUndefined();
		expect(reads).toBe(0);
	});
});
