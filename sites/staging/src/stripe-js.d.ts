/**
 * The `Stripe` global that `js.stripe.com/v3/` installs — declared here so the
 * ONE inline script on this site (`/checkout/pay`, ADR-0012) typechecks under
 * `astro check` instead of riding a `Could not find name 'Stripe'` hint.
 *
 * Deliberately MINIMAL: only the four calls that page makes. This is not an
 * attempt to mirror Stripe's API surface — a fuller typing would be a
 * maintenance liability with no consumer, and `@stripe/stripe-js` is a
 * dependency this site does not need (the script tag is the integration).
 */

interface StripePaymentElement {
	mount(selector: string): void;
}

interface StripeElements {
	create(type: "payment"): StripePaymentElement;
}

interface StripeConfirmPaymentResult {
	error?: { message?: string };
}

interface StripeJs {
	elements(options: { clientSecret: string | undefined }): StripeElements;
	confirmPayment(options: {
		elements: StripeElements;
		confirmParams: { return_url: string | undefined };
	}): Promise<StripeConfirmPaymentResult>;
}

declare function Stripe(publishableKey: string | undefined): StripeJs;
