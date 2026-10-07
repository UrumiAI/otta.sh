/**
 * Type-level contract for the `X402Rail` port (ADR-0028 Decision 2, increment 6).
 *
 * Checked by `pnpm typecheck`, not vitest: each `@ts-expect-error` must be
 * triggered, so a loosened type fails the build.
 */
import { expectTypeOf } from "vitest";
import type {
	X402DecodedPayment,
	X402OpaquePayload,
	X402Rail,
	X402SettleResult,
	X402VerifyResult,
} from "../src/index.js";
import type { Cents } from "../src/money/cents.js";

// The wire payload is opaque: the domain cannot hand-build one for the
// facilitator, so only the adapter's own `decode` can produce it.
// @ts-expect-error — a plain object is not an X402OpaquePayload
const forged: X402OpaquePayload = {};

// The decoded amount is money: branded cents, never a bare number or string.
expectTypeOf<X402DecodedPayment["amount"]>().toEqualTypeOf<Cents>();
// The window is exact: the wire allows uint256, so no float `number`.
expectTypeOf<X402DecodedPayment["validBefore"]>().toEqualTypeOf<bigint>();

// verify and settle never throw "could not ask": each has a third arm.
expectTypeOf<X402VerifyResult["outcome"]>().toEqualTypeOf<"valid" | "invalid" | "unavailable">();
expectTypeOf<X402SettleResult["outcome"]>().toEqualTypeOf<"settled" | "rejected" | "unconfirmed">();

// IO methods are async; the structural ones are not.
expectTypeOf<ReturnType<X402Rail["verify"]>>().toEqualTypeOf<Promise<X402VerifyResult>>();
expectTypeOf<ReturnType<X402Rail["settle"]>>().toEqualTypeOf<Promise<X402SettleResult>>();
expectTypeOf<ReturnType<X402Rail["decode"]>>().not.toEqualTypeOf<Promise<unknown>>();

// Reference the const so oxlint doesn't flag an unused local in this
// deliberately type-only file.
export const typeOnlyRefs = { forged };
