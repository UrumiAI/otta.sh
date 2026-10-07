/**
 * `PaymentEventStore` over two collections: one document per dedupe key, and one
 * per recorded anomaly.
 *
 * The SQL held both in `payment_events`, separated by a nullable UNIQUE column: a
 * delivery row carries a `dedupe_key` and no `kind`, an anomaly row carries a
 * `kind` and a NULL `dedupe_key`, and the nullable UNIQUE is what let many
 * anomalies coexist while a real dedupe key collided. A document id cannot be
 * null, so the two shapes become two collections — which is the same separation
 * stated in the schema rather than in a convention about which columns are set.
 *
 * | Document | What it is |
 * |---|---|
 * | `payment_events/{dedupeKey}` | the received-events audit row; its id is the once-only |
 * | `payment_anomalies/{digest}` | one alert-worthy settlement anomaly |
 *
 * **Dedupe is the document id, so `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * becomes `compareAndSet(key, null, …)`.** `true` is the first delivery and
 * `false` a redelivery, exactly as before — and, as before, a `false` does NOT
 * short-circuit settlement: the row is an audit record, and "settles once" is
 * carried by the guarded state flips and the keyed side-effects, so a redelivery
 * re-drives them and heals a crash between any two.
 *
 * **A dedupe key that arrives against a different order still answers `false`.**
 * The SQL's UNIQUE was global and its conflict clause silent, so this is faithful
 * rather than lenient. What `false` alone cannot say is WHOSE row it collided
 * with, and that is the whole cross-order replay question for x402, where the
 * dedupe key IS the on-chain transaction — so the port also asks
 * {@link EmdashPaymentEventStore.orderForDedupeKey}, which reads the stored row's
 * `orderId` back, and `settleOrder` refuses a receipt already bound elsewhere.
 * The order store's `payment_refs/{providerRef}` claim is the other half, and
 * still the one that guards the captured total and therefore the refund ceiling.
 *
 * **Anomalies are keyed by a digest of what they record, so a replay that produces
 * the identical anomaly records it once.** The port asks for "idempotent enough for
 * replay safety" and the SQL delivered rather less than that — every call inserted
 * a fresh id, so a redelivered webhook hitting the same invariant wrote a second
 * indistinguishable row. Two anomalies that agree on order, gateway, kind, detail
 * and instant are the same anomaly by every field an operator can see, so they
 * collapse; anything that differs, including the instant, is a separate document.
 * Nothing is ever swallowed: the alert seam is the row, and the row is always
 * there.
 */
import type {
	OrderId,
	PaymentEventStore,
	PaymentMethod,
	RecordAnomalyInput,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";
import { hashToken } from "./token-hash.js";

/** Collection name: one received-event row per dedupe key. */
export const PAYMENT_EVENTS_COLLECTION = "payment_events";
/** Collection name: one settlement anomaly per digest of its own fields. */
export const PAYMENT_ANOMALIES_COLLECTION = "payment_anomalies";

/** One collection as the plugin descriptor declares it. */
export interface PaymentEventCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The two collections this store owns. Neither declares an index: nothing queries
 * either one. A dedupe key is read by its own id, and an anomaly is never read
 * back by this adapter at all — it is written to be alerted on, and the operator
 * surface that eventually reads them is a separate concern with its own indexes to
 * declare when it exists.
 */
export const PAYMENT_EVENT_COLLECTIONS: Readonly<
	Record<string, PaymentEventCollectionIndexDeclaration>
> = {
	[PAYMENT_EVENTS_COLLECTION]: {},
	[PAYMENT_ANOMALIES_COLLECTION]: {},
};

/** `payment_events/{dedupeKey}` — the audit row for one gateway delivery. */
export interface PaymentEventDoc {
	readonly orderId: string;
	readonly gateway: PaymentMethod;
	readonly receivedAt: string;
}

/** `payment_anomalies/{digest}` — one alert-worthy settlement anomaly. */
export interface PaymentAnomalyDoc {
	readonly orderId: string;
	readonly gateway: PaymentMethod;
	readonly kind: string;
	readonly detail: string;
	readonly recordedAt: string;
}

/**
 * The separator the digest's parts are joined by: ASCII unit separator, which no
 * order id, gateway, kind, timestamp or operator-written detail carries.
 */
const FIELD_SEPARATOR = "\u001f";

/**
 * The anomaly's document id: a SHA-256 of its five fields, joined by a separator
 * no field can contain.
 *
 * A digest rather than a join, because `detail` is free text of unbounded length
 * and a document id is not the place for it — and because the parts then need no
 * escaping to be unambiguous.
 */
export async function paymentAnomalyId(input: RecordAnomalyInput): Promise<string> {
	return hashToken(
		[input.orderId, input.gateway, input.kind, input.now, input.detail].join(FIELD_SEPARATOR),
	);
}

export interface EmdashPaymentEventStoreOptions {
	/** The collections the descriptor declared (`PAYMENT_EVENT_COLLECTIONS`). */
	storage: StorageAccess;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
}

export class EmdashPaymentEventStore implements PaymentEventStore {
	readonly #events: StorageCollection<PaymentEventDoc>;
	readonly #anomalies: StorageCollection<PaymentAnomalyDoc>;
	readonly #retry: CasRetryOptions;

	constructor(options: EmdashPaymentEventStoreOptions) {
		this.#events = collectionOf<PaymentEventDoc>(options.storage, PAYMENT_EVENTS_COLLECTION);
		this.#anomalies = collectionOf<PaymentAnomalyDoc>(
			options.storage,
			PAYMENT_ANOMALIES_COLLECTION,
		);
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
	}

	/**
	 * Claim `dedupeKey`. `true` is the first delivery; `false` a redelivery.
	 *
	 * `now` is the caller's instant rather than this store's clock, because the port
	 * passes it: the settle path stamps one instant and every row it writes agrees
	 * with it.
	 */
	async dedupe(
		dedupeKey: string,
		orderId: OrderId,
		gateway: PaymentMethod,
		now: string,
	): Promise<boolean> {
		return this.#cas<boolean>("dedupePaymentEvent", async () => {
			const written = await this.#events.compareAndSet(dedupeKey, null, {
				orderId,
				gateway,
				receivedAt: now,
			});
			if (written.applied) return casDone(true);
			// A refused create-if-absent is the conflict clause firing: the key is
			// already recorded, so this delivery is a redelivery. The read back is what
			// distinguishes that from a document deleted between the two statements —
			// nothing in this package deletes one, so a null there is a retry rather
			// than an answer.
			const held = await this.#events.get(dedupeKey);
			return held === null ? CAS_RETRY : casDone(false);
		});
	}

	/** The order the recorded `dedupeKey` document names, or `null` when no
	 *  document holds that key. A plain `get`: the dedupe key IS the document id. */
	async orderForDedupeKey(dedupeKey: string): Promise<OrderId | null> {
		const held = await this.#events.get(dedupeKey);
		return held === null ? null : (held.orderId as OrderId);
	}

	/** Record an anomaly. Idempotent for an identical replay; never swallowed. */
	async recordAnomaly(input: RecordAnomalyInput): Promise<void> {
		const id = await paymentAnomalyId(input);
		await this.#cas<void>("recordPaymentAnomaly", async () => {
			const written = await this.#anomalies.compareAndSet(id, null, {
				orderId: input.orderId,
				gateway: input.gateway,
				kind: input.kind,
				detail: input.detail,
				recordedAt: input.now,
			});
			if (written.applied) return casDone(undefined);
			// The identical anomaly is already recorded — the digest is over every field
			// there is, so there is nothing this call could add.
			const held = await this.#anomalies.get(id);
			return held === null ? CAS_RETRY : casDone(undefined);
		});
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}
