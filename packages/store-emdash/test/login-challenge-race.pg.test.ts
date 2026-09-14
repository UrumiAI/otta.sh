/**
 * The per-address challenge cap under real concurrency — the case ADR-0019 §7.17
 * says must be written, against the race the SQL adapter still has.
 *
 * The SQL counted active challenges for an address and then inserted, in two
 * statements, with no transaction and no constraint on the table: N concurrent
 * requests could all read a count below the cap and all insert. So this suite is
 * not a port of an existing one — there was no existing one, which is exactly why
 * the record refuses to let the behaviour be inherited silently.
 *
 * It is **Postgres-required** and stays that way: better-sqlite3 serializes writes
 * in-process, so it can verify the statements but cannot lose a race. What is being
 * proven is that the throttle claim admits EXACTLY the cap out of a crowd, that a
 * freed slot is worth exactly one more admission and never two, and that the cap is
 * per address rather than global.
 */
import { email, type Email } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { IDENTITY_LAYOUT } from "./identity-collections.js";
import { makeIdentityHarness, type IdentityHarness } from "./identity-harness.js";
import { settleOne } from "./helpers/fault-injection.js";

/**
 * The hand-set attempt budget the admission step is held to — deliberately tighter
 * than `CAS_MAX_ATTEMPTS`, so raising the package ceiling can never turn a passing
 * shape green by accident.
 *
 * The bound is a property of the DOCUMENT, not of the crowd: an attempt is lost only
 * when a peer's admission committed, and once the window is full every remaining
 * caller is refused with no write at all. So the depth tracks the cap plus the peers
 * that can commit while one caller is in flight, not N.
 *
 * Measured at 4 for the stampede at N=40, 3 for the two concurrent crowds and 2 for
 * the recycled slot — against a cap of 3 in every shape, which is the point: the
 * crowd grew thirteenfold and the depth did not move with it.
 */
const CAS_ATTEMPT_BUDGET = 12;

interface Fixture {
	harness: IdentityHarness;
	maxAttempts(): number;
	maxAttemptsFor(operation: string): number;
	reset(): Promise<void>;
	close(): Promise<void>;
}

/** One isolated Postgres schema, its own pool, and a depth observer over it. */
async function fresh(poolMax: number, cap: number): Promise<Fixture> {
	const db = await makePgStorage(IDENTITY_LAYOUT, poolMax);
	let deepest = 0;
	const perOperation = new Map<string, number>();
	const harness = makeIdentityHarness(db.storage, {
		maxActiveChallenges: cap,
		onCasAttempts: (operation, attempts) => {
			deepest = Math.max(deepest, attempts);
			perOperation.set(operation, Math.max(perOperation.get(operation) ?? 0, attempts));
		},
	});
	return {
		harness,
		maxAttempts: () => deepest,
		maxAttemptsFor: (operation) => perOperation.get(operation) ?? 0,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}

/** Fire N concurrent challenge requests and classify the answers. */
async function stampede(
	harness: IdentityHarness,
	to: Email,
	n: number,
): Promise<{ admitted: number; throttled: number; failures: unknown[] }> {
	const results = await Promise.all(
		Array.from({ length: n }, () => settleOne(harness.verifier.issueChallenge(to))),
	);
	let admitted = 0;
	let throttled = 0;
	const failures: unknown[] = [];
	for (const result of results) {
		if (typeof result === "object" && result !== null && "ok" in result) {
			const answer = result as { ok: boolean; reason?: string };
			if (answer.ok) admitted++;
			else if (answer.reason === "THROTTLED") throttled++;
			else failures.push(result);
		} else failures.push(result);
	}
	return { admitted, throttled, failures };
}

describe.skipIf(!PG_ENABLED)("login challenge throttle [postgres]", () => {
	test("fires N concurrent issueChallenge at a cap of M (M<N); exactly M are admitted", async () => {
		const M = 3;
		const N = 40;
		const LOOPS = 15;
		const EMAIL = email("stampede@example.com");
		const fx = await fresh(N + 4, M);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const outcome = await stampede(fx.harness, EMAIL, N);
				expect(outcome.failures, `loop ${String(loop)}: unexpected failures`).toEqual([]);
				expect(outcome.admitted, `loop ${String(loop)}: admitted`).toBe(M);
				expect(outcome.throttled, `loop ${String(loop)}: throttled`).toBe(N - M);
				// The window holds exactly M slots, and exactly M challenges exist: the
				// slot and the document it names are written by one caller in that order,
				// so a count that disagreed would mean a slot had been double-spent.
				expect(await fx.harness.slotsOf("stampede@example.com")).toHaveLength(M);
				expect(await fx.harness.challenges.count()).toBe(M);
			}
			expect(fx.maxAttemptsFor("issueChallenge.admit")).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 120_000);

	test("a slot freed by a consume is worth exactly one more admission, never two", async () => {
		const M = 3;
		const N = 20;
		const LOOPS = 10;
		const EMAIL = email("recycle@example.com");
		const fx = await fresh(N + 4, M);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				// Fill the window, and keep one challenge to redeem.
				const first = await fx.harness.verifier.issueChallenge(EMAIL);
				if (!first.ok) throw new Error("the first request must be admitted");
				for (let i = 1; i < M; i++) {
					expect((await fx.harness.verifier.issueChallenge(EMAIL)).ok).toBe(true);
				}
				// One consume frees one slot, concurrently with a crowd trying to take it.
				const [redeemed, crowd] = await Promise.all([
					fx.harness.verifier.verifyChallenge(first.challengeId, first.token),
					stampede(fx.harness, EMAIL, N),
				]);
				expect(redeemed.ok, `loop ${String(loop)}: the redeem`).toBe(true);
				expect(crowd.failures, `loop ${String(loop)}: unexpected failures`).toEqual([]);
				// Zero or one — never two. The slot may be freed before or after any given
				// racer counted the window, so admitting none is a legitimate ordering; what
				// must never happen is one freed slot admitting two requests.
				expect(crowd.admitted, `loop ${String(loop)}: admitted`).toBeLessThanOrEqual(1);
				expect(
					await fx.harness.slotsOf("recycle@example.com"),
					`loop ${String(loop)}: slots held`,
				).toHaveLength(M - 1 + crowd.admitted);
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 120_000);

	test("the cap is per address: concurrent crowds on two addresses each get their own", async () => {
		const M = 3;
		const N = 20;
		const fx = await fresh(2 * N + 4, M);
		try {
			const [one, two] = await Promise.all([
				stampede(fx.harness, email("crowd-one@example.com"), N),
				stampede(fx.harness, email("crowd-two@example.com"), N),
			]);
			expect(one.failures).toEqual([]);
			expect(two.failures).toEqual([]);
			expect(one.admitted).toBe(M);
			expect(two.admitted).toBe(M);
			expect(await fx.harness.challenges.count()).toBe(2 * M);
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 120_000);
});
