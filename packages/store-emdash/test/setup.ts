/**
 * Shared per-case setup for every store-emdash suite.
 *
 * The storage guard's heal state (resume cursor, cool-down, in-flight walk) lives
 * at module scope, keyed by database handle and collection name, because that is
 * what a real process needs (see `well-formed-storage.ts`). In a suite it would
 * leak from one case into the next — a cool-down armed by one case failing the
 * next case's reads fast — so it is forgotten after every case (review round 2,
 * A R2-A4).
 */
import { afterEach } from "vitest";
import { resetHealStateForTests } from "../src/well-formed-storage.js";

afterEach(() => {
	resetHealStateForTests();
});
