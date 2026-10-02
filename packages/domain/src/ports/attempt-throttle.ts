/**
 * The `AttemptThrottle` port: at most N attempts per KEY inside a sliding window.
 *
 * It is the sign-in throttle's mechanism (ADR-0004: a per-address window of
 * slots, each lapsing on its own) offered for attempts that are not sign-ins —
 * first, guessing the email behind an order link to resume its payment (QA U-2).
 * `admit` takes a slot and answers `true`, or answers `false` and takes nothing.
 * A slot is never given back early: a SUCCESSFUL attempt counts too, so the cap
 * is on tries, not on failures.
 */
export interface AttemptThrottle {
	admit(key: string): Promise<boolean>;
}
