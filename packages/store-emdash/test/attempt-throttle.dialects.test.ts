/**
 * The domain's `AttemptThrottle` contract against the document adapter, on every
 * Node dialect — the sign-in throttle's slot window (`login_challenge_claims`,
 * `liveSlots`) reused for attempts that are not sign-ins (QA U-2). Plus the one
 * thing the contract cannot see: its documents never share a key with an
 * address's sign-in window.
 */
import { attemptThrottleContract, CountingIdGen, FixedClock } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { collectionOf } from "../src/collection-of.js";
import { EmdashAttemptThrottle } from "../src/emdash-attempt-throttle.js";
import {
	LOGIN_CHALLENGE_CLAIMS_COLLECTION,
	type ChallengeThrottleDoc,
} from "../src/identity-documents.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { IDENTITY_LAYOUT } from "./identity-collections.js";
import { MAX_ACTIVE_CHALLENGES, makeIdentityHarness } from "./identity-harness.js";
import { email } from "@otta-sh/domain";

describeEachDialect("EmdashAttemptThrottle", (ctx) => {
	const bound = ctx.useStorage(IDENTITY_LAYOUT);
	let n = 0;
	attemptThrottleContract(
		async () => {
			const clock = new FixedClock(new Date("2026-10-02T12:00:00.000Z"));
			const windowMs = 1000;
			const maxAttempts = 3;
			n++;
			return {
				throttle: new EmdashAttemptThrottle({
					storage: bound.storage,
					clock,
					idGen: new CountingIdGen(`att${n}-`),
					windowMs,
					maxAttempts,
					// Each case's keys are its own (the storage outlives a case).
					keyPrefix: `case${n}:`,
				}),
				advance: (ms) => clock.advance(ms),
				windowMs,
				maxAttempts,
			};
		},
		{ dialect: ctx.dialect },
	);

	test("its window documents are namespaced apart from any address's sign-in window", async () => {
		const throttle = new EmdashAttemptThrottle({
			storage: bound.storage,
			clock: new FixedClock(new Date("2026-10-02T12:00:00.000Z")),
			idGen: new CountingIdGen("ns-"),
			windowMs: 1000,
			maxAttempts: 1,
		});
		expect(await throttle.admit("resume:order-1")).toBe(true);
		const docs = collectionOf<ChallengeThrottleDoc>(
			bound.storage,
			LOGIN_CHALLENGE_CLAIMS_COLLECTION,
		);
		expect(await docs.get("attempt:resume:order-1")).not.toBeNull();
		expect(await docs.get("resume:order-1")).toBeNull();
	});

	test("spending an attempt window never touches a sign-in window — and the reverse", async () => {
		const identity = makeIdentityHarness(bound.storage, { idPrefix: "iso-" });
		const throttle = new EmdashAttemptThrottle({
			storage: bound.storage,
			clock: identity.clock,
			idGen: new CountingIdGen("iso-att-"),
			windowMs: 60_000,
			maxAttempts: 5,
		});
		// Five resume guesses on an order, AND five on a key spelled exactly like
		// an address: the address's sign-in window is untouched.
		for (let i = 0; i < 5; i++) {
			expect(await throttle.admit("resume:order-iso")).toBe(true);
			expect(await throttle.admit("signin@example.test")).toBe(true);
		}
		expect(await throttle.admit("resume:order-iso")).toBe(false);
		expect((await identity.verifier.issueChallenge(email("signin@example.test"))).ok).toBe(true);

		// The reverse: an address at its sign-in cap leaves an attempt key of the
		// same spelling free.
		for (let i = 0; i < MAX_ACTIVE_CHALLENGES; i++) {
			expect((await identity.verifier.issueChallenge(email("capped@example.test"))).ok).toBe(true);
		}
		expect(await identity.verifier.issueChallenge(email("capped@example.test"))).toEqual({
			ok: false,
			reason: "THROTTLED",
		});
		expect(await throttle.admit("capped@example.test")).toBe(true);
	});
});
