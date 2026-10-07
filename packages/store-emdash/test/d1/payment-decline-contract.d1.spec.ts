/**
 * The domain's `paymentDeclineContract` (ADR-0022, issue #304) on **D1** — the
 * dialect Otta actually ships on. The harness is `test/payment-decline-harness.ts`,
 * imported rather than restated; it names no Node driver, so it loads inside
 * `workerd`. Only the storage BINDING differs, and `describe-d1.ts` supplies it.
 */
import { paymentDeclineContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "../coupon-collections.js";
import { makePaymentDeclineHarness } from "../payment-decline-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(PAYMENT_DECLINE_LAYOUT);

paymentDeclineContract(() => makePaymentDeclineHarness(bound.storage), { dialect: "d1" });
