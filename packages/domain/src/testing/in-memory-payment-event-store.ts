import type { OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";
import type { PaymentEventStore, RecordAnomalyInput } from "../ports/payment-event-store.js";

export interface RecordedAnomaly {
	orderId: string;
	gateway: PaymentMethod;
	kind: string;
	detail: string;
}

/**
 * IO-free `PaymentEventStore` fake. The UNIQUE `dedupe_key` makes redelivery a
 * no-op (first delivery ⇒ true); anomalies are recorded durably (never swallowed).
 */
export class InMemoryPaymentEventStore implements PaymentEventStore {
	#dedupeKeys = new Set<string>();
	#anomalies: RecordedAnomaly[] = [];

	async dedupe(
		dedupeKey: string,
		_orderId: OrderId,
		_gateway: PaymentMethod,
		_now: string,
	): Promise<boolean> {
		if (this.#dedupeKeys.has(dedupeKey)) return false;
		this.#dedupeKeys.add(dedupeKey);
		return true;
	}

	async recordAnomaly(input: RecordAnomalyInput): Promise<void> {
		this.#anomalies.push({
			orderId: input.orderId,
			gateway: input.gateway,
			kind: input.kind,
			detail: input.detail,
		});
	}

	// -- test surface ---------------------------------------------------------

	anomalies(): RecordedAnomaly[] {
		return [...this.#anomalies];
	}
}
