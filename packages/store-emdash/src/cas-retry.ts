/**
 * The bounded, jittered compare-and-set retry — and the typed error a caller
 * gets when the budget runs out.
 *
 * `compareAndSet` is the only general read-modify-write atomicity primitive a
 * plugin has: read the document with its revision, compute the next value in JS,
 * commit it against that revision. `{ applied: false }` means somebody else
 * committed first, so the whole step is re-run against the new value. A
 * host-level retryable abort (Postgres `40001` serialization failure or `40P01`
 * deadlock, surfaced as a structural `StorageSerializationError`) is the same
 * situation and is retried identically.
 *
 * **This is a permanent contention budget, not an interim one.** There is no
 * nested-path guarded update available, so a hot SKU's aggregate is written by
 * read-modify-write and will retry under load. The answer is a bounded budget, a
 * typed retryable failure, and measurement — never an unbounded loop (which turns
 * contention into a hung request) and never a silent give-up.
 */
import { isStorageSerializationError } from "./storage-access.js";

/**
 * The attempt ceiling per compare-and-set step.
 *
 * **Why 24, and why it used to be 12.** Every failed attempt means a *different*
 * writer committed to the same document, so what a writer can lose is bounded by
 * how many peers can successfully commit while it is in flight — and that bound is
 * a property of the DOCUMENT, not of the crowd.
 *
 * - The **inventory** bound is the units. N shoppers racing for M units on one SKU
 *   produce at most M successful writes before the guard turns every remaining
 *   caller into a clean `OUT_OF_STOCK` with no write at all, so the depth tracks M,
 *   not N. 12 was chosen for that shape, with room for the flash-sale
 *   restock-in-the-middle case; it is measured at 6 for the flash sale and at the
 *   old ceiling only for the merchant removal shape, where a REFUSED removal still
 *   writes its ledger entry and the writes are therefore not unit-bounded.
 * - The **order document** bound is money movements, and it is roughly
 *   `2 × (refunds that fit under the ceiling) + 1` — each gateway refund writes
 *   TWICE (the reservation, then the finalize) and the ceiling-reaching one folds
 *   the `→ refunded` flip into its second write. A 1,000-cent ceiling refunded 100
 *   at a time is 10 refunds, so 21 peer writes, and the refunds increment measured
 *   a depth of 11 against the old 12 — inside it, but only by luck of ordering.
 *
 * So 24 covers the worse of the two bounds instead of the better one. **The extra
 * attempts buy jittered backoff on a path that would otherwise throw**
 * {@link StorageContentionError}: a caller that was going to be told "too busy" now
 * waits instead, and nothing about the invariants changes either way — a losing
 * writer never applies its update, and an exhausted budget is still a typed
 * retryable refusal rather than a wrong answer or a hung request. The worst-case
 * wall time is bounded by {@link CAS_MAX_DELAY_MS}, which caps each sleep at 50 ms.
 *
 * A change to this number is a change to the contention budget: measure first (every
 * race suite records the maximum depth observed), then move it. The per-shape
 * assertions all bound the measured depth AT or BELOW this constant, so raising it
 * never turns a passing shape green by accident — `CAS_ATTEMPT_BUDGET` in
 * `test/inventory-crash-seams.dialects.test.ts` stays the tighter, hand-set 8 that
 * the flash-sale shape is held to.
 */
export const CAS_MAX_ATTEMPTS = 24;

/** First backoff, in milliseconds. Doubles per attempt, then full-jittered. */
export const CAS_BASE_DELAY_MS = 2;

/** Backoff ceiling, in milliseconds. Keeps the worst case inside a request. */
export const CAS_MAX_DELAY_MS = 50;

/**
 * The retry budget for one document ran out: the write did NOT happen, and the
 * caller may try again.
 *
 * **It must never be collapsed into `{ ok: false, reason: "OUT_OF_STOCK" }`.**
 * `ReserveResult` has no member for "too busy", and a shopper who could have
 * bought must not be told the item is gone — that is a lost sale reported as a
 * fact about the product. At the HTTP/route boundary this maps to **503** with a
 * retry (for the cart route, a retry of the whole call); wiring that mapping is a
 * later increment, and until it exists the error propagating uncaught is the
 * correct behaviour, because it is loud.
 */
export class StorageContentionError extends Error {
	override readonly name = "StorageContentionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "STORAGE_CONTENTION";
	/** Always retryable: nothing was written. */
	readonly retryable = true as const;
	/** How many attempts were spent (the ceiling in force at the time). */
	readonly attempts: number;
	/** Which store operation gave up, for the log line. */
	readonly operation: string;

	constructor(operation: string, attempts: number, options?: { cause?: unknown }) {
		super(
			`${operation} could not commit after ${String(attempts)} compare-and-set attempts — ` +
				"the document is contended; nothing was written, so the call is safe to retry",
			// The last retryable abort seen, if any. Without it a storm of
			// `40001`/`40P01` aborts and a storm of lost revision races are
			// indistinguishable in a log, and they have different remedies.
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.operation = operation;
		this.attempts = attempts;
	}
}

/** Structural test for {@link StorageContentionError}. */
export function isStorageContentionError(err: unknown): err is StorageContentionError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "STORAGE_CONTENTION"
	);
}

/**
 * One attempt's outcome: either the step reached a decision (its compare-and-set
 * applied, or it resolved without needing one) or the document moved underneath
 * it and the whole step must be recomputed.
 */
export type CasStep<T> = { readonly done: true; readonly value: T } | { readonly done: false };

/** The step reached a decision. */
export function casDone<T>(value: T): CasStep<T> {
	return { done: true, value };
}

/** The document moved: re-read and recompute. */
export const CAS_RETRY: CasStep<never> = { done: false };

export interface CasRetryOptions {
	/** Override the ceiling. Defaults to {@link CAS_MAX_ATTEMPTS}. */
	maxAttempts?: number;
	/** Observer for the attempt depth actually spent — how contention is measured. */
	onAttempts?: (operation: string, attempts: number) => void;
	/** Injectable sleep (tests run without real backoff). */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable jitter source, so a test can make the backoff deterministic. */
	random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Run `step` until it reaches a decision, re-running it whenever the document it
 * read was committed by somebody else first.
 *
 * `step` must re-read the document (and its revision) on every invocation — the
 * whole point is that the computation is redone against the new value, not that
 * the same write is retried.
 */
export async function withCasRetry<T>(
	operation: string,
	step: (attempt: number) => Promise<CasStep<T>>,
	options: CasRetryOptions = {},
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? CAS_MAX_ATTEMPTS;
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;

	// The last retryable abort swallowed by the loop. It is not discarded: if the
	// budget runs out it becomes the thrown error's `cause`.
	let lastAbort: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let outcome: CasStep<T> | undefined;
		try {
			outcome = await step(attempt);
		} catch (err) {
			// A retryable host abort is the same situation as a lost revision race:
			// nothing was applied, so recompute. Anything else is the caller's.
			if (!(isStorageSerializationError(err) && err.retryable)) throw err;
			lastAbort = err;
		}
		if (outcome !== undefined && outcome.done) {
			options.onAttempts?.(operation, attempt);
			return outcome.value;
		}
		if (attempt < maxAttempts) {
			const ceiling = Math.min(CAS_BASE_DELAY_MS * 2 ** (attempt - 1), CAS_MAX_DELAY_MS);
			await sleep(random() * ceiling);
		}
	}

	options.onAttempts?.(operation, maxAttempts);
	throw new StorageContentionError(operation, maxAttempts, { cause: lastAbort });
}
