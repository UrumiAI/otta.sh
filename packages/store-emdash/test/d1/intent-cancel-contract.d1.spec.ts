/**
 * The domain's `intentCancelContract` on **D1** — the dialect Otta actually ships
 * on. Harness: `test/payment-decline-harness.ts`, which names no Node driver and
 * so loads inside `workerd`.
 */
import { intentCancelContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "../coupon-collections.js";
import { makePaymentDeclineHarness } from "../payment-decline-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(PAYMENT_DECLINE_LAYOUT);

intentCancelContract(() => makePaymentDeclineHarness(bound.storage), { dialect: "d1" });
