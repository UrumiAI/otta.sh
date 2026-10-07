import { describe, expect, test } from "vitest";
import { encodeX402Header } from "../src/index.js";
import {
	BASE_SEPOLIA,
	SPEC_PAY_TO,
	SPEC_PAYER,
	SPEC_PAYMENT_SIGNATURE_HEADER,
	SPEC_TRANSACTION,
	specPaymentPayload,
	USDC_BASE_SEPOLIA,
} from "./support/fixtures.js";
import { makeRail, offerOrThrow } from "./support/harness.js";

/** `specs/transports-v2/http.md`, "Payment Required Signaling": the example
 *  `PAYMENT-REQUIRED` header, verbatim. */
const SPEC_PAYMENT_REQUIRED_HEADER =
	"eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";

/** The same file, "Settlement Response Delivery": success and failure. */
const SPEC_PAYMENT_RESPONSE_SUCCESS =
	"eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9";
const SPEC_PAYMENT_RESPONSE_FAILURE =
	"eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3JSZWFzb24iOiJpbnN1ZmZpY2llbnRfZnVuZHMiLCJ0cmFuc2FjdGlvbiI6IiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9";

/**
 * `encodeX402Header` (ADR-0028 Decision 5 A / 9: the site sends
 * `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`): JSON, UTF-8, standard base64 —
 * byte-identical to the spec's own examples, and the inverse of `decode`.
 */
describe("encodeX402Header", () => {
	test("reproduces the spec's PAYMENT-REQUIRED example byte for byte", () => {
		expect(
			encodeX402Header({
				x402Version: 2,
				error: "PAYMENT-SIGNATURE header is required",
				resource: {
					url: "https://api.example.com/premium-data",
					description: "Access to premium market data",
					mimeType: "application/json",
				},
				accepts: [
					{
						scheme: "exact",
						network: BASE_SEPOLIA,
						amount: "10000",
						asset: USDC_BASE_SEPOLIA,
						payTo: SPEC_PAY_TO,
						maxTimeoutSeconds: 60,
						extra: { name: "USDC", version: "2" },
					},
				],
			}),
		).toBe(SPEC_PAYMENT_REQUIRED_HEADER);
	});

	test("reproduces the spec's PAYMENT-RESPONSE examples, success and failure", () => {
		expect(
			encodeX402Header({
				success: true,
				transaction: SPEC_TRANSACTION,
				network: BASE_SEPOLIA,
				payer: SPEC_PAYER,
			}),
		).toBe(SPEC_PAYMENT_RESPONSE_SUCCESS);
		expect(
			encodeX402Header({
				success: false,
				errorReason: "insufficient_funds",
				transaction: "",
				network: BASE_SEPOLIA,
				payer: SPEC_PAYER,
			}),
		).toBe(SPEC_PAYMENT_RESPONSE_FAILURE);
	});

	test("reproduces the spec's PAYMENT-SIGNATURE example, which decode accepts", () => {
		const header = encodeX402Header(specPaymentPayload());
		expect(header).toBe(SPEC_PAYMENT_SIGNATURE_HEADER);
		expect(makeRail().rail.decode(header).ok).toBe(true);
	});

	test("our own PaymentRequired, with an error, round-trips through UTF-8", () => {
		const offer = offerOrThrow(makeRail().rail);
		const withError = { ...offer.paymentRequired, error: "payment_window_closed — try again" };
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(encodeX402Header(withError)), (c) => c.charCodeAt(0)),
		);
		expect(JSON.parse(decoded)).toEqual(withError);
	});
});
