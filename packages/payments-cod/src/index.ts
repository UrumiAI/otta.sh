import type {
	CancelIntentResult,
	ConfirmationResult,
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
	RefundResult,
} from "@urumi.ai/otta-domain";

/**
 * Cash on delivery as a `PaymentGateway` (ADR-0044). It is an OFFLINE method
 * (`PAYMENT_METHOD_SETTLEMENT.cod === "offline"` in the domain): no online
 * payment exists, so every verb answers what "nothing to call" means.
 *
 *  - `createIntent` places nothing at a provider. It answers `clientAction:
 *    { kind: "offline" }` — "the order is placed; the buyer pays on delivery" —
 *    with an EMPTY `intentId`, so the order records no intent and the
 *    intent-cancel sweep never has one to withdraw. Deterministic, so a same-key
 *    replay gets the same handle.
 *  - `verifyConfirmation` always rejects (`UNKNOWN_EVENT`): there is no webhook,
 *    and nothing that arrives at a settle route may mark a COD order paid. A
 *    person does, through the admin's Mark paid (`transitionOrderAsAdmin`).
 *  - `refundable: false` and `refund` → `UNSUPPORTED`: cash goes back by hand,
 *    and the operator records it as a MANUAL refund in Money → Refunds.
 *  - `cancelIntent` → `UNSUPPORTED`: there is no standing intent to withdraw.
 *
 * No secrets, no IO and no imports beyond the domain's types: it is sandbox-clean
 * by construction (test/sandbox-clean-guard.test.ts).
 */
export class CashOnDeliveryGateway implements PaymentGateway {
	readonly id = "cod" as const;
	readonly refundable = false;

	async createIntent(_input: CreateIntentInput): Promise<PaymentIntentHandle> {
		return { gateway: this.id, intentId: "", clientAction: { kind: "offline" } };
	}

	async verifyConfirmation(): Promise<ConfirmationResult> {
		return { ok: false, reason: "UNKNOWN_EVENT" };
	}

	async refund(): Promise<RefundResult> {
		return { ok: false, reason: "UNSUPPORTED" };
	}

	async cancelIntent(): Promise<CancelIntentResult> {
		return { ok: false, reason: "UNSUPPORTED" };
	}
}
