import { cents, currency } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	BASE,
	BASE_SEPOLIA,
	encodeHeader,
	SPEC_NONCE,
	SPEC_PAY_TO,
	SPEC_PAYER,
	SPEC_PAYMENT_SIGNATURE_HEADER,
	SPEC_SETTLE_SUCCESS,
	SPEC_V1_X_PAYMENT_HEADER,
	SPEC_VERIFY_VALID,
	specErc7710Payload,
	specPaymentPayload,
	specPermit2Payload,
	USDC_BASE_SEPOLIA,
	type SpecPayload,
} from "./support/fixtures.js";
import {
	decodeOrThrow,
	makeRail,
	offerOrThrow,
	ONE_CENT,
	payAsTheDomainWould,
} from "./support/harness.js";

const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";

/** The spec payload padded with trailing JSON whitespace to `bytes`. */
function paddedTo(bytes: number): string {
	const json = JSON.stringify(specPaymentPayload());
	return encodeHeader(json + " ".repeat(bytes - json.length));
}

/** The spec example with one field broken, as a header. */
function corrupt(edit: (p: SpecPayload) => void): string {
	const payload = specPaymentPayload();
	edit(payload);
	return encodeHeader(payload);
}

/**
 * ADR-0028 Decision 5 steps 1–2 (the strict decoder and the structural match)
 * and Decision 12's "Bad payloads reach the facilitator zero times" and
 * "Accepted, not refused".
 */
describe("X402Rail.decode", () => {
	test("decodes the spec's own PAYMENT-SIGNATURE example into what the domain decides on", () => {
		const { rail } = makeRail();
		const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		expect(payment).toMatchObject({
			paymentKey: `eip3009:84532:${USDC_BASE_SEPOLIA}:${SPEC_PAYER}:${SPEC_NONCE}`.toLowerCase(),
			network: BASE_SEPOLIA,
			payer: SPEC_PAYER.toLowerCase(),
			nonce: SPEC_NONCE,
			amount: cents(1),
			currency: currency("USD"),
			validAfter: 1740672089n,
			validBefore: 1740672154n,
		});
	});

	test("the recorded header is the spec's decoded JSON (the fixtures agree with each other)", () => {
		expect(encodeHeader(specPaymentPayload())).toBe(SPEC_PAYMENT_SIGNATURE_HEADER);
	});

	test("the amount converts back exactly, past 2^53 included", () => {
		const { rail } = makeRail();
		const header = corrupt((p) => {
			p.accepted.amount = "90071992547409910000";
			p.payload.authorization.value = "90071992547409910000";
		});
		expect(decodeOrThrow(rail, header).amount).toBe(Number.MAX_SAFE_INTEGER);
	});

	test("decode is pure: no network call", () => {
		const { rail, facilitator } = makeRail();
		rail.decode(SPEC_PAYMENT_SIGNATURE_HEADER);
		rail.decode("not base64 at all");
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});
});

describe("bad payloads reach the facilitator zero times", () => {
	const malformed: Array<[string, string, string]> = [
		// encoding
		["an empty header", "", "encoding"],
		["characters outside base64", "eyJ4NDAy%%%", "encoding"],
		[
			"the base64url alphabet",
			SPEC_PAYMENT_SIGNATURE_HEADER.slice(0, 40).replace(/.$/u, "-"),
			"encoding",
		],
		["not UTF-8 once decoded", btoa("\xff\xfe{}"), "encoding"],
		["not JSON", encodeHeader("x402 please"), "json"],
		["JSON that is not an object", encodeHeader([1, 2]), "shape"],
		["JSON null", encodeHeader("null"), "shape"],
		// versions
		["the v1 X-PAYMENT example", SPEC_V1_X_PAYMENT_HEADER, "version"],
		["x402Version as a string", corrupt((p) => (p.x402Version = "2")), "version"],
		["x402Version 3", corrupt((p) => (p.x402Version = 3)), "version"],
		// shape
		["no accepted", corrupt((p) => delete p.accepted), "shape"],
		["no payload", corrupt((p) => delete p.payload), "shape"],
		["no authorization", corrupt((p) => delete p.payload.authorization), "shape"],
		["no signature", corrupt((p) => delete p.payload.signature), "signature"],
		[
			"maxTimeoutSeconds as a string",
			corrupt((p) => (p.accepted.maxTimeoutSeconds = "60")),
			"shape",
		],
		["extra that is not an object", corrupt((p) => (p.accepted.extra = "USDC")), "shape"],
		// network
		[
			"a non-EVM network",
			corrupt((p) => (p.accepted.network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")),
			"network",
		],
		["an empty chain id", corrupt((p) => (p.accepted.network = "eip155:")), "network"],
		// pinned formats
		[
			"a nonce of 31 bytes",
			corrupt((p) => (p.payload.authorization.nonce = SPEC_NONCE.slice(0, -2))),
			"nonce",
		],
		[
			"a nonce without 0x",
			corrupt((p) => (p.payload.authorization.nonce = SPEC_NONCE.slice(2))),
			"nonce",
		],
		[
			"a nonce with a non-hex digit",
			corrupt((p) => (p.payload.authorization.nonce = `${SPEC_NONCE.slice(0, -1)}g`)),
			"nonce",
		],
		[
			"from with 39 hex digits",
			corrupt((p) => (p.payload.authorization.from = SPEC_PAYER.slice(0, -1))),
			"address",
		],
		[
			"from without 0x",
			corrupt((p) => (p.payload.authorization.from = SPEC_PAYER.slice(2))),
			"address",
		],
		[
			"to with 41 hex digits",
			corrupt((p) => (p.payload.authorization.to = `${SPEC_PAY_TO}0`)),
			"address",
		],
		["to as a number", corrupt((p) => (p.payload.authorization.to = 1)), "address"],
		["asset that is not an address", corrupt((p) => (p.accepted.asset = "USDC")), "address"],
		["payTo that is not an address", corrupt((p) => (p.accepted.payTo = "merchant")), "address"],
		[
			"validAfter negative",
			corrupt((p) => (p.payload.authorization.validAfter = "-1")),
			"valid_after",
		],
		[
			"validAfter in exponent form",
			corrupt((p) => (p.payload.authorization.validAfter = "1e9")),
			"valid_after",
		],
		[
			"validAfter as a JSON number",
			corrupt((p) => (p.payload.authorization.validAfter = 1740672089)),
			"valid_after",
		],
		["validAfter empty", corrupt((p) => (p.payload.authorization.validAfter = "")), "valid_after"],
		[
			"validBefore fractional",
			corrupt((p) => (p.payload.authorization.validBefore = "1740672154.5")),
			"valid_before",
		],
		[
			"validBefore with a space",
			corrupt((p) => (p.payload.authorization.validBefore = " 1740672154")),
			"valid_before",
		],
		[
			"validAfter past uint256",
			corrupt((p) => (p.payload.authorization.validAfter = (2n ** 256n).toString())),
			"valid_after",
		],
		[
			"validBefore past uint256",
			corrupt((p) => (p.payload.authorization.validBefore = (2n ** 256n).toString())),
			"valid_before",
		],
		["maxTimeoutSeconds zero", corrupt((p) => (p.accepted.maxTimeoutSeconds = 0)), "shape"],
		[
			"a leading byte-order mark",
			encodeHeader(`\uFEFF${JSON.stringify(specPaymentPayload())}`),
			"json",
		],
		// value (Decision 3)
		[
			"value not divisible by 10^4",
			corrupt((p) => {
				p.accepted.amount = "10001";
				p.payload.authorization.value = "10001";
			}),
			"value",
		],
		[
			"value zero",
			corrupt((p) => {
				p.accepted.amount = "0";
				p.payload.authorization.value = "0";
			}),
			"value",
		],
		[
			"value with a leading zero",
			corrupt((p) => {
				p.accepted.amount = "010000";
				p.payload.authorization.value = "010000";
			}),
			"value",
		],
		[
			"value with a sign",
			corrupt((p) => {
				p.accepted.amount = "+10000";
				p.payload.authorization.value = "+10000";
			}),
			"value",
		],
		[
			"value in exponent form",
			corrupt((p) => {
				p.accepted.amount = "1e4";
				p.payload.authorization.value = "1e4";
			}),
			"value",
		],
		[
			"value of 32 digits",
			corrupt((p) => {
				p.accepted.amount = `1${"0".repeat(31)}`;
				p.payload.authorization.value = `1${"0".repeat(31)}`;
			}),
			"value",
		],
		[
			"value past the largest safe cents",
			corrupt((p) => {
				p.accepted.amount = "90071992547409920000";
				p.payload.authorization.value = "90071992547409920000";
			}),
			"value",
		],
		[
			"accepted.amount disagreeing with the signed value",
			corrupt((p) => (p.accepted.amount = "20000")),
			"value",
		],
		// signature
		[
			"a 64-byte signature",
			corrupt((p) => (p.payload.signature = p.payload.signature.slice(0, -2))),
			"signature",
		],
		[
			"an odd-length signature",
			corrupt((p) => (p.payload.signature = `${p.payload.signature}0`)),
			"signature",
		],
		[
			"a signature without 0x",
			corrupt((p) => (p.payload.signature = p.payload.signature.slice(2))),
			"signature",
		],
		// transfer method: EIP-3009 only
		["the spec's Permit2 payload", encodeHeader(specPermit2Payload()), "transfer_method"],
		["the spec's ERC-7710 payload", encodeHeader(specErc7710Payload()), "transfer_method"],
		[
			"assetTransferMethod permit2 over an EIP-3009 authorization",
			corrupt((p) => (p.accepted.extra.assetTransferMethod = "permit2")),
			"transfer_method",
		],
		[
			"assetTransferMethod in another case",
			corrupt((p) => (p.accepted.extra.assetTransferMethod = "EIP3009")),
			"transfer_method",
		],
		[
			"an EIP-3009 authorization alongside a Permit2 one",
			corrupt(
				(p) => (p.payload.permit2Authorization = specPermit2Payload().payload.permit2Authorization),
			),
			"transfer_method",
		],
	];

	test.each(malformed)("MALFORMED: %s", async (_label, header, detail) => {
		const { rail, facilitator } = makeRail();
		const outcome = await payAsTheDomainWould(rail, header, offerOrThrow(rail));
		expect(outcome).toEqual({ refused: { ok: false, reason: "MALFORMED", detail } });
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});

	describe("the 16 KiB header bound", () => {
		test("a header of exactly 16384 base64 characters decodes", () => {
			const { rail } = makeRail();
			const header = paddedTo(12_288);
			expect(header).toHaveLength(16_384);
			expect(rail.decode(header).ok).toBe(true);
		});

		test("one block more is too large, before any decoding", async () => {
			const { rail, facilitator } = makeRail();
			const header = paddedTo(12_289);
			expect(header.length).toBeGreaterThan(16_384);
			expect(await payAsTheDomainWould(rail, header, offerOrThrow(rail))).toEqual({
				refused: { ok: false, reason: "MALFORMED", detail: "too_large" },
			});
			expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
		});
	});

	const mismatched: Array<[string, string, string]> = [
		["another scheme", corrupt((p) => (p.accepted.scheme = "upto")), "scheme"],
		["a network we do not offer", corrupt((p) => (p.accepted.network = BASE)), "network"],
		["another asset on our network", corrupt((p) => (p.accepted.asset = OTHER_ADDRESS)), "asset"],
		[
			"accepted.payTo that is not ours",
			corrupt((p) => (p.accepted.payTo = OTHER_ADDRESS)),
			"payTo",
		],
		[
			"authorization.to that is not ours",
			corrupt((p) => (p.payload.authorization.to = OTHER_ADDRESS)),
			"to",
		],
		[
			"the Base mainnet token name on Base Sepolia",
			corrupt((p) => (p.accepted.extra.name = "USD Coin")),
			"extra",
		],
		["another token version", corrupt((p) => (p.accepted.extra.version = "1")), "extra"],
		["no extra", corrupt((p) => delete p.accepted.extra), "extra"],
	];

	test.each(mismatched)("PAYMENT_MISMATCH: %s", async (_label, header, field) => {
		const { rail, facilitator } = makeRail();
		const outcome = await payAsTheDomainWould(rail, header, offerOrThrow(rail));
		expect(outcome).toEqual({ refused: { ok: false, reason: "PAYMENT_MISMATCH", field } });
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});

	test("matchOffer never compares the amount: the domain checks it against the order", () => {
		const { rail } = makeRail();
		const payment = decodeOrThrow(
			rail,
			corrupt((p) => {
				p.accepted.amount = "20000";
				p.payload.authorization.value = "20000";
			}),
		);
		expect(rail.matchOffer(payment, offerOrThrow(rail, ONE_CENT)).ok).toBe(true);
	});

	test("verify and settle refuse, without a call, a payment that does not match the offer", async () => {
		// Defence in depth: the domain matches first, but the adapter never sends
		// a payment it would not have matched.
		const { rail, facilitator } = makeRail();
		const payment = decodeOrThrow(
			rail,
			corrupt((p) => (p.payload.authorization.to = OTHER_ADDRESS)),
		);
		const offer = offerOrThrow(rail);
		expect(await rail.verify(payment, offer)).toEqual({
			outcome: "unavailable",
			cause: "offer_mismatch",
		});
		expect(await rail.settle(payment, offer)).toEqual({
			outcome: "unconfirmed",
			cause: "offer_mismatch",
		});
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});

	test("a spread copy with edited public fields is refused, with zero calls (identity, not shape)", async () => {
		const { rail, facilitator } = makeRail({ networks: [BASE, BASE_SEPOLIA] });
		const decoded = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		const offer = offerOrThrow(rail);
		const edited = { ...decoded, network: BASE, amount: cents(999) };
		expect(rail.matchOffer(edited, offer)).toEqual({
			ok: false,
			reason: "PAYMENT_MISMATCH",
			field: "payload",
		});
		expect(await rail.verify(edited, offer)).toEqual({
			outcome: "unavailable",
			cause: "offer_mismatch",
		});
		expect(await rail.settle(edited, offer)).toEqual({
			outcome: "unconfirmed",
			cause: "offer_mismatch",
		});
		// Even an unedited copy is not the object decode returned.
		expect(rail.matchOffer({ ...decoded }, offer)).toMatchObject({ field: "payload" });
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});

	test("an offer from another rail, or a copy of ours, is refused with zero calls", async () => {
		const { rail, facilitator } = makeRail();
		const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		const foreign = offerOrThrow(makeRail().rail);
		const copied = { ...offerOrThrow(rail) };
		for (const offer of [foreign, copied]) {
			expect(await rail.verify(payment, offer)).toEqual({
				outcome: "unavailable",
				cause: "offer_mismatch",
			});
			expect(await rail.settle(payment, offer)).toEqual({
				outcome: "unconfirmed",
				cause: "offer_mismatch",
			});
		}
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});

	test("a validBefore of exactly uint256 max decodes", () => {
		const { rail } = makeRail();
		const max = (2n ** 256n - 1n).toString();
		expect(
			decodeOrThrow(
				rail,
				corrupt((p) => (p.payload.authorization.validBefore = max)),
			).validBefore,
		).toBe(2n ** 256n - 1n);
	});

	test("verify and settle refuse, without a call, a payment this adapter did not decode", async () => {
		const { rail, facilitator } = makeRail();
		const decoded = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		const forged = { ...decoded, payload: JSON.parse("{}") as typeof decoded.payload };
		const offer = offerOrThrow(rail);
		expect(rail.matchOffer(forged, offer)).toMatchObject({ ok: false });
		expect(await rail.verify(forged, offer)).toMatchObject({ outcome: "unavailable" });
		expect(await rail.settle(forged, offer)).toMatchObject({ outcome: "unconfirmed" });
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});
});

describe("accepted, not refused", () => {
	test.each([
		["all upper-case hex", (a: string) => `0x${a.slice(2).toUpperCase()}`],
		["all lower-case hex", (a: string) => a.toLowerCase()],
	])("an address in %s compares equal (20-byte comparison)", async (_label, recase) => {
		const { rail, facilitator } = makeRail();
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		facilitator.onSettle({ status: 200, body: SPEC_SETTLE_SUCCESS });
		const header = corrupt((p) => {
			p.accepted.payTo = recase(SPEC_PAY_TO);
			p.accepted.asset = recase(USDC_BASE_SEPOLIA);
			p.payload.authorization.to = recase(SPEC_PAY_TO);
			p.payload.authorization.from = recase(SPEC_PAYER);
		});
		const outcome = await payAsTheDomainWould(rail, header, offerOrThrow(rail));
		expect(outcome).toMatchObject({ verify: { outcome: "valid" }, settle: { outcome: "settled" } });
	});

	test("a configured lower-case payTo matches a checksummed payload", () => {
		const { rail } = makeRail({ payTo: SPEC_PAY_TO.toLowerCase() });
		const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		expect(rail.matchOffer(payment, offerOrThrow(rail)).ok).toBe(true);
	});

	test("assetTransferMethod eip3009 is accepted, and so is its absence (the spec example)", () => {
		const { rail } = makeRail();
		const offer = offerOrThrow(rail);
		const explicit = corrupt((p) => (p.accepted.extra.assetTransferMethod = "eip3009"));
		expect(rail.matchOffer(decodeOrThrow(rail, explicit), offer).ok).toBe(true);
		const absent = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		expect(rail.matchOffer(absent, offer).ok).toBe(true);
	});

	test("a 1.5 KiB ERC-6492 signature is accepted", () => {
		const { rail } = makeRail();
		const magic = "6492".repeat(16); // the ERC-6492 32-byte magic suffix
		const signature = `0x${"ab".repeat(1536 - 32)}${magic}`;
		expect((signature.length - 2) / 2).toBe(1536);
		const payment = decodeOrThrow(
			rail,
			corrupt((p) => (p.payload.signature = signature)),
		);
		expect(rail.matchOffer(payment, offerOrThrow(rail)).ok).toBe(true);
	});
});
