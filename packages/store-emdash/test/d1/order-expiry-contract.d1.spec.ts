/**
 * The domain's `orderExpiryContract` (QA2 M2) on **D1** — the dialect Otta ships
 * on. Same harness as the decline spec (`test/payment-decline-harness.ts`); only
 * the storage BINDING differs, and `describe-d1.ts` supplies it.
 */
import { orderExpiryContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "../coupon-collections.js";
import { makePaymentDeclineHarness } from "../payment-decline-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(PAYMENT_DECLINE_LAYOUT);

orderExpiryContract(() => makePaymentDeclineHarness(bound.storage), { dialect: "d1" });
