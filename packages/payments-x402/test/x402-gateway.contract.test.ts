import { cents, currency as toCurrency, orderId as toOrderId } from "@otta-sh/domain";
import { buildGatewayHarness, paymentGatewayContract } from "@otta-sh/domain/testing";
import { createTestFacilitator, signX402Proof, X402PaymentGateway } from "../src/index.js";

const SECRET = "x402_facilitator_test_secret";

type ConfirmInput = Parameters<ReturnType<typeof buildGatewayHarness>["confirm"]>[0];

function mint(input: ConfirmInput, secret: string) {
	const proof = signX402Proof(
		{
			orderId: toOrderId(input.orderId),
			transaction: input.dedupeKey,
			network: "eip155:8453",
			payer: "0xbuyer",
			amount: cents(input.amountCents),
			currency: toCurrency(input.currency),
		},
		secret,
	);
	return { kind: "page_gate" as const, proof };
}

// paymentGatewayContract against the REAL x402 adapter (§8 step 4.7): the same
// verify→dedupe→settle→commit/grant behavior. Confirmations are page-gate proofs
// facilitator-verified server-side (offline HMAC facilitator, no network).
paymentGatewayContract(
	() => {
		const gateway = new X402PaymentGateway({
			facilitator: createTestFacilitator(SECRET),
			payTo: "0xTEST",
			accepts: ["eip155:8453"],
		});
		return buildGatewayHarness({
			gateway,
			confirm: (input) => mint(input, SECRET),
			confirmBadSignature: (input) => mint(input, "wrong_secret"),
		});
	},
	{ gateway: "x402" },
);
