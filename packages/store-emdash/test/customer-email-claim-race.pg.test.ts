/**
 * Email uniqueness under real concurrency — what the `customers.email` UNIQUE
 * constraint gave for free, now assembled out of a claim document and a
 * compare-and-set.
 *
 * It is **Postgres-required** and stays that way: better-sqlite3 serializes writes
 * in-process, so it can verify the statements but cannot lose a race. Three things
 * are being proven, and the third is the one a claim design can get wrong:
 *
 * 1. Of N concurrent registrations of one address exactly one succeeds and the rest
 *    raise the domain's own `DuplicateCustomerEmailError` — the error the login
 *    use-case already re-reads on.
 * 2. A loser leaves NOTHING: one customer document, one claim, and the claim names
 *    the winner. The claim is taken before any customer write, so a loser never
 *    wrote one; and the compensating release cannot take the winner's claim away,
 *    because it is pinned to a revision and to its own customer id.
 * 3. The verifier's get-or-create resolves N concurrent redeems of one address to
 *    ONE customer id. That path races `create` against itself deliberately — it is
 *    the only caller that expects the duplicate error — so it is the one that would
 *    expose a claim which refused without the account being reachable.
 */
import { email, DuplicateCustomerEmailError } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { IDENTITY_LAYOUT } from "./identity-collections.js";
import { makeIdentityHarness, type IdentityHarness } from "./identity-harness.js";
import { settleOne } from "./helpers/fault-injection.js";

/**
 * The hand-set attempt budget every shape here is held to — tighter than
 * `CAS_MAX_ATTEMPTS`, so raising the package ceiling cannot turn a passing shape
 * green by accident.
 *
 * The bound is a property of the claim document: an attempt is lost only when a peer
 * wrote the claim, and a claim a live account holds refuses every later caller with
 * no write at all. So the depth tracks the takeovers, not the crowd.
 */
const CAS_ATTEMPT_BUDGET = 12;

interface Fixture {
	harness: IdentityHarness;
	maxAttempts(): number;
	reset(): Promise<void>;
	close(): Promise<void>;
}

async function fresh(poolMax: number, cap?: number): Promise<Fixture> {
	const db = await makePgStorage(IDENTITY_LAYOUT, poolMax);
	let deepest = 0;
	const harness = makeIdentityHarness(db.storage, {
		maxActiveChallenges: cap,
		onCasAttempts: (_operation, attempts) => {
			deepest = Math.max(deepest, attempts);
		},
	});
	return {
		harness,
		maxAttempts: () => deepest,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}

describe.skipIf(!PG_ENABLED)("customer email claim [postgres]", () => {
	test("fires N concurrent create() for one address; exactly one wins and the losers leave nothing", async () => {
		const N = 30;
		const LOOPS = 15;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const results = await Promise.all(
					Array.from({ length: N }, () =>
						settleOne(fx.harness.customerStore.create({ email: email("RACE@Example.com") })),
					),
				);
				const winners = results.filter((r) => !(r instanceof Error));
				const duplicates = results.filter((r) => r instanceof DuplicateCustomerEmailError);
				expect(winners, `loop ${String(loop)}: winners`).toHaveLength(1);
				expect(duplicates, `loop ${String(loop)}: duplicates`).toHaveLength(N - 1);
				// One account document, and NO half-registered losers: a caller that did not
				// take the claim never reached a customer write at all.
				expect(await fx.harness.customers.count(), `loop ${String(loop)}: documents`).toBe(1);
				const claim = await fx.harness.emailClaims.get("race@example.com");
				const winner = await fx.harness.customerStore.getByEmail(email("race@example.com"));
				expect(claim?.customerId, `loop ${String(loop)}: the claim names the winner`).toBe(
					winner?.id,
				);
				// And nothing else is claimed: the losers' compensating releases removed their
				// own claims and could not touch the winner's.
				expect(await fx.harness.emailClaims.count(), `loop ${String(loop)}: claims`).toBe(1);
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);

	test("N concurrent redeems of one address resolve to ONE customer (get-or-create race)", async () => {
		const N = 12;
		const LOOPS = 8;
		const EMAIL = email("getorcreate@example.com");
		const fx = await fresh(N + 4, N);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const issued = [];
				for (let i = 0; i < N; i++) {
					const result = await fx.harness.verifier.issueChallenge(EMAIL);
					if (!result.ok) throw new Error("the cap was widened for this shape");
					issued.push(result);
				}
				const verified = await Promise.all(
					issued.map((challenge) =>
						settleOne(fx.harness.verifier.verifyChallenge(challenge.challengeId, challenge.token)),
					),
				);
				const ids = new Set<string>();
				for (const result of verified) {
					expect(result, `loop ${String(loop)}`).toMatchObject({ ok: true });
					const answer = result as { ok: true; customerId: string };
					ids.add(answer.customerId);
				}
				// One id for every redeem, and one document behind it.
				expect(ids.size, `loop ${String(loop)}: distinct customer ids`).toBe(1);
				expect(await fx.harness.customers.count(), `loop ${String(loop)}: documents`).toBe(1);
				expect(await fx.harness.emailClaims.count(), `loop ${String(loop)}: claims`).toBe(1);
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);
});
