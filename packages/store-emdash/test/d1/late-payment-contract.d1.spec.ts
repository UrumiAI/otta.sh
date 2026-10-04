/**
 * The domain's `latePaymentContract` on **D1** — the dialect Otta actually ships
 * on. Harness: `test/late-payment-harness.ts`, which names no Node driver and so
 * loads inside `workerd`.
 */
import { latePaymentContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "../coupon-collections.js";
import { makeLatePaymentHarness } from "../late-payment-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(PAYMENT_DECLINE_LAYOUT);

latePaymentContract(() => makeLatePaymentHarness(bound.storage), { dialect: "d1" });
