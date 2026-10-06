/**
 * Recorded, real-shape x402 fixtures (ADR-0028 Decision 12, increment 6).
 *
 * Everything here is copied from the spec or the reference implementation at
 * `coinbase/x402@dd927a26`, or from the facilitator probe ADR-0028 Decision 8
 * records, so the adapter is tested against what a real client sends and a real
 * facilitator answers rather than against shapes this repo invented. Each
 * constant names its source.
 */

export const BASE = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** `specs/transports-v2/http.md`, "Payment Payload Transmission": the example
 *  `PAYMENT-SIGNATURE` header, verbatim. It pays 10000 atomic USDC (1¢) on Base
 *  Sepolia to {@link SPEC_PAY_TO}. */
export const SPEC_PAYMENT_SIGNATURE_HEADER =
	"eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIiwiZGVzY3JpcHRpb24iOiJBY2Nlc3MgdG8gcHJlbWl1bSBtYXJrZXQgZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRlZCI6eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwicGF5VG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHgyZDZhNzU4OGQ2YWNjYTUwNWNiZjBkOWE0YTIyN2UwYzUyYzZjMzQwMDhjOGU4OTg2YTEyODMyNTk3NjQxNzM2MDhhMmNlNjQ5NjY0MmUzNzdkNmRhOGRiYmY1ODM2ZTliZDE1MDkyZjllY2FiMDVkZWQzZDYyOTNhZjE0OGI1NzFjIiwiYXV0aG9yaXphdGlvbiI6eyJmcm9tIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJ2YWx1ZSI6IjEwMDAwIiwidmFsaWRBZnRlciI6IjE3NDA2NzIwODkiLCJ2YWxpZEJlZm9yZSI6IjE3NDA2NzIxNTQiLCJub25jZSI6IjB4ZjM3NDY2MTNjMmQ5MjBiNWZkYWJjMDg1NmYyYWViMmQ0Zjg4ZWU2MDM3YjhjYzVkMDRhNzFhNDQ2MmYxMzQ4MCJ9fX0=";

/** `specs/transports-v1/http.md`: the example v1 `X-PAYMENT` header, verbatim
 *  (`x402Version: 1`, network `base-sepolia`). */
export const SPEC_V1_X_PAYMENT_HEADER =
	"eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiYmFzZS1zZXBvbGlhIiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweDJkNmE3NTg4ZDZhY2NhNTA1Y2JmMGQ5YTRhMjI3ZTBjNTJjNmMzNDAwOGM4ZTg5ODZhMTI4MzI1OTc2NDE3MzYwOGEyY2U2NDk2NjQyZTM3N2Q2ZGE4ZGJiZjU4MzZlOWJkMTUwOTJmOWVjYWIwNWRlZDNkNjI5M2FmMTQ4YjU3MWMiLCJhdXRob3JpemF0aW9uIjp7ImZyb20iOiIweDg1N2IwNjUxOUU5MWUzQTU0NTM4NzkxYkRiYjBFMjIzNzNlMzZiNjYiLCJ0byI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsInZhbHVlIjoiMTAwMDAiLCJ2YWxpZEFmdGVyIjoiMTc0MDY3MjA4OSIsInZhbGlkQmVmb3JlIjoiMTc0MDY3MjE1NCIsIm5vbmNlIjoiMHhmMzc0NjYxM2MyZDkyMGI1ZmRhYmMwODU2ZjJhZWIyZDRmODhlZTYwMzdiOGNjNWQwNGE3MWE0NDYyZjEzNDgwIn19fQ==";

/** The spec example's recipient, payer, nonce and signature (v2 §5.2.1). */
export const SPEC_PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
export const SPEC_PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
export const SPEC_NONCE = "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480";
export const SPEC_SIGNATURE =
	"0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c";

/** The spec's example transaction hash (v2 §5.3.1, §7.2). */
export const SPEC_TRANSACTION =
	"0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

/** The decoded JSON of {@link SPEC_PAYMENT_SIGNATURE_HEADER} (v2 §5.2.1), as a
 *  fresh mutable copy each call so a test can break exactly one field. */
export function specPaymentPayload(): SpecPayload {
	return {
		x402Version: 2,
		resource: {
			url: "https://api.example.com/premium-data",
			description: "Access to premium market data",
			mimeType: "application/json",
		},
		accepted: {
			scheme: "exact",
			network: BASE_SEPOLIA,
			amount: "10000",
			asset: USDC_BASE_SEPOLIA,
			payTo: SPEC_PAY_TO,
			maxTimeoutSeconds: 60,
			extra: { name: "USDC", version: "2" },
		},
		payload: {
			signature: SPEC_SIGNATURE,
			authorization: {
				from: SPEC_PAYER,
				to: SPEC_PAY_TO,
				value: "10000",
				validAfter: "1740672089",
				validBefore: "1740672154",
				nonce: SPEC_NONCE,
			},
		},
	};
}

// oxlint-disable-next-line typescript/no-explicit-any -- a test payload is deliberately loosely typed so a case can corrupt any field
export type SpecPayload = Record<string, any>;

/** `exact-EVM` §2, Phase 2: the example Permit2 payload (its trailing commas
 *  removed so it parses). */
export function specPermit2Payload(): SpecPayload {
	return {
		x402Version: 2,
		accepted: {
			scheme: "exact",
			network: BASE_SEPOLIA,
			amount: "10000",
			payTo: SPEC_PAY_TO,
			maxTimeoutSeconds: 60,
			asset: USDC_BASE_SEPOLIA,
			extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" },
		},
		payload: {
			signature: SPEC_SIGNATURE,
			permit2Authorization: {
				permitted: { token: USDC_BASE_SEPOLIA, amount: "10000" },
				from: SPEC_PAYER,
				spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
				nonce: "33247007178036348590600198031289925668252061821958005840077069883511451257277",
				deadline: "1740672154",
				witness: { to: SPEC_PAY_TO, validAfter: "1740672089" },
			},
		},
	};
}

/** `exact-EVM` §3, Phase 2: the example ERC-7710 payload. */
export function specErc7710Payload(): SpecPayload {
	return {
		x402Version: 2,
		accepted: {
			scheme: "exact",
			network: BASE_SEPOLIA,
			amount: "10000",
			asset: USDC_BASE_SEPOLIA,
			payTo: SPEC_PAY_TO,
			maxTimeoutSeconds: 60,
			extra: { assetTransferMethod: "erc7710", name: "USDC", version: "2" },
		},
		payload: {
			delegationManager: "0xDelegationManagerAddress",
			permissionContext: "0x",
			delegator: SPEC_PAYER,
		},
	};
}

/** The reference client's header encoding (`safeBase64Encode`,
 *  `typescript/packages/core/src/utils/index.ts:148`): UTF-8 JSON, standard
 *  base64 with padding. */
export function encodeHeader(value: unknown): string {
	const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

// --- Facilitator answers -------------------------------------------------

/** v2 §7.1, "Successful Response". */
export const SPEC_VERIFY_VALID = { isValid: true, payer: SPEC_PAYER };

/** v2 §7.1, "Error Response". */
export const SPEC_VERIFY_INVALID = {
	isValid: false,
	invalidReason: "insufficient_funds",
	payer: SPEC_PAYER,
};

/** `x402.org/facilitator`, probed 2026-10-06 (ADR-0028 Decision 8): a bad
 *  signature answered 200 with this body… */
export const X402_ORG_BAD_SIGNATURE = {
	status: 200,
	body: { isValid: false, invalidReason: "invalid_exact_evm_signature" },
};

/** …and a malformed payload answered 500 with this one. */
export const X402_ORG_MALFORMED = {
	status: 500,
	body: { isValid: false, invalidReason: "unexpected_error" },
};

/** v2 §7.2, "Successful Response". */
export const SPEC_SETTLE_SUCCESS = {
	success: true,
	payer: SPEC_PAYER,
	transaction: SPEC_TRANSACTION,
	network: BASE_SEPOLIA,
};

/** v2 §7.2, "Error Response". */
export const SPEC_SETTLE_ERROR = {
	success: false,
	errorReason: "insufficient_funds",
	payer: SPEC_PAYER,
	transaction: "",
	network: BASE_SEPOLIA,
};

/** The reference facilitator's `catch` after `transferWithAuthorization` was
 *  sent (`mechanisms/evm/src/exact/facilitator/eip3009.ts:322-329`): an error it
 *  does not recognise is mapped to `invalid_exact_evm_transaction_failed` with an
 *  EMPTY transaction, even though the transfer may still land. */
export const REFERENCE_SETTLE_CATCH = {
	success: false,
	errorReason: "invalid_exact_evm_transaction_failed",
	transaction: "",
	network: BASE_SEPOLIA,
	payer: SPEC_PAYER,
};

/** The reference facilitator's reverted-receipt answer (`eip3009.ts:306-313`):
 *  the transaction was mined and failed. */
export const REFERENCE_SETTLE_REVERTED = {
	success: false,
	errorReason: "invalid_exact_evm_transaction_failed",
	transaction: "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
	network: BASE_SEPOLIA,
	payer: SPEC_PAYER,
};

/**
 * ADR-0028 Decision 5, step 8: the pre-broadcast allowlist, both spellings —
 * the spec's (v2 §9) and the reference facilitator's
 * (`mechanisms/evm/src/exact/facilitator/errors.ts`). Pinned here by hand, not
 * imported, so a change to the adapter's list fails a test.
 */
export const PRE_BROADCAST_ALLOWLIST = [
	// Not enough funds
	"insufficient_funds",
	"invalid_exact_evm_insufficient_balance",
	// Bad signature
	"invalid_exact_evm_payload_signature",
	"invalid_exact_evm_signature",
	// Not yet valid / expired (same string in both)
	"invalid_exact_evm_payload_authorization_valid_after",
	"invalid_exact_evm_payload_authorization_valid_before",
	// Wrong amount
	"invalid_exact_evm_payload_authorization_value_mismatch",
	"invalid_exact_evm_authorization_value",
	// Wrong recipient
	"invalid_exact_evm_payload_recipient_mismatch",
	"invalid_exact_evm_recipient_mismatch",
	// Wrong network
	"invalid_network",
	"invalid_exact_evm_network_mismatch",
	// Wrong scheme
	"invalid_scheme",
	"unsupported_scheme",
	"invalid_exact_evm_scheme",
	// Bad payload or requirements
	"invalid_payload",
	"invalid_payment_requirements",
	"invalid_x402_version",
	"invalid_exact_evm_missing_eip712_domain",
	"invalid_exact_evm_token_name_mismatch",
	"invalid_exact_evm_token_version_mismatch",
	"invalid_exact_evm_eip3009_not_supported",
] as const;
