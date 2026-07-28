/**
 * `deriveSaveIdempotencyKey` — the `version` component and its degradation
 * contract (emdash 8d6b20b / #2143, shipped 0.30.0).
 *
 * The sandbox-level proof that a frozen `updatedAt` no longer collapses two
 * distinct saves lives in `sync-hooks.sandbox.test.ts`. This file pins the pure
 * function's edges, which the sandbox test cannot reach: the shape of the key
 * when the host emits no `version` at all.
 */
import { describe, expect, test } from "vitest";
import { deriveSaveIdempotencyKey } from "../src/sync/derive-idempotency-key.js";

const WM = "2026-07-10T00:00:00.000Z";

describe("deriveSaveIdempotencyKey", () => {
	test("a FROZEN updatedAt with a bumped version yields DISTINCT keys (the #2143 regression)", () => {
		expect(deriveSaveIdempotencyKey("products", "p1", WM, 2)).not.toBe(
			deriveSaveIdempotencyKey("products", "p1", WM, 3),
		);
	});

	test("an identical redelivery (same updatedAt AND same version) yields the SAME key, so replay dedupe still holds", () => {
		expect(deriveSaveIdempotencyKey("products", "p1", WM, 7)).toBe(
			deriveSaveIdempotencyKey("products", "p1", WM, 7),
		);
	});

	test("a moving updatedAt still yields distinct keys even at a constant version (pre-0.30.0 hosts)", () => {
		expect(deriveSaveIdempotencyKey("products", "p1", WM, 1)).not.toBe(
			deriveSaveIdempotencyKey("products", "p1", "2026-07-10T01:00:00.000Z", 1),
		);
	});

	test("the key-space stays disjoint per collection and per id", () => {
		const key = deriveSaveIdempotencyKey("products", "p1", WM, 1);
		expect(deriveSaveIdempotencyKey("posts", "p1", WM, 1)).not.toBe(key);
		expect(deriveSaveIdempotencyKey("products", "p2", WM, 1)).not.toBe(key);
	});

	test("ABSENT version ⇒ the pre-change key, byte for byte (older/different hosts see no change)", () => {
		expect(deriveSaveIdempotencyKey("products", "p1", WM)).toBe(`products:p1:${WM}`);
		expect(deriveSaveIdempotencyKey("products", "p1", WM, undefined)).toBe(`products:p1:${WM}`);
		expect(deriveSaveIdempotencyKey("products", "p1", WM, null)).toBe(`products:p1:${WM}`);
	});

	test("a present version is appended as its own segment", () => {
		expect(deriveSaveIdempotencyKey("products", "p1", WM, 4)).toBe(`products:p1:${WM}:4`);
	});
});
