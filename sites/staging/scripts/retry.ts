/**
 * A bounded retry for the e2e seed's first requests (issue #447). A cold dev
 * server can drop or 5xx the first call it gets while it re-optimizes its
 * dependencies; one more try a moment later succeeds. The bound is the point:
 * a server that is really broken fails after `attempts` tries, by name.
 */

/** Thrown by a retried function to say "this failure may pass — try again". */
export class RetryableError extends Error {}

export interface RetryOptions {
	/** Total tries, including the first. At least 1. */
	attempts: number;
	/** Wait between tries, in milliseconds. */
	delayMs: number;
	/** Injected so a test needn't wait. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn` until it returns, retrying only when it throws a
 * {@link RetryableError}. Any other error — and the last retryable one —
 * propagates unchanged.
 */
export async function retryBounded<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
	const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (!(err instanceof RetryableError) || attempt >= options.attempts) throw err;
			await sleep(options.delayMs);
		}
	}
}
