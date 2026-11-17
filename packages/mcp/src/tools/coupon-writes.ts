/**
 * The coupon WRITE tools. Each validates its input, calls the plugin's admin
 * OPERATION (`createCoupon`, `patchCoupon`, `retireCoupon`, `deleteCoupon` —
 * never a surface write: the operation classifies a create's collision, types a
 * currency refusal, and makes an edit PARTIAL over the surface's full replace),
 * and turns the outcome into success data or a `toolFailure` with a stable code.
 *
 * A refusal's `message` from the operation is internal text: it travels in
 * `details`, and the agent-facing message is written here.
 */
import type { CouponType, CouponWire, CouponWriteOutcome } from "@urumi.ai/otta-plugin";
import { createCoupon, deleteCoupon, patchCoupon, retireCoupon } from "@urumi.ai/otta-plugin";
import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { MONEY_NOTE, readOrRefuse } from "./common.js";
import { type Complete, unhandled } from "./unhandled.js";

/** The domain's `CouponType`. */
const COUPON_TYPES = ["fixed_amount", "percentage"] as const satisfies readonly CouponType[];
const couponTypesComplete: Complete<CouponType, typeof COUPON_TYPES> = true;
void couponTypesComplete;

const couponIdInput = z
	.string()
	.min(1)
	.describe("The coupon's `id` from coupons_list (not its code).");

const minorUnits = (what: string) =>
	z.number().int().nonnegative().nullable().optional().describe(`${what}; null clears it.`);
const count = (what: string) =>
	z.number().int().nonnegative().nullable().optional().describe(`${what}; null means no limit.`);
const instant = (what: string) =>
	z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe(`${what}, an ISO-8601 UTC instant (2026-01-01T00:00:00.000Z); null clears it.`);

/** The fields create and update share. */
const economics = {
	amountCents: minorUnits("A fixed_amount coupon's discount, integer minor units"),
	rateBps: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.optional()
		.describe("A percentage coupon's rate in basis points (1000 = 10%)."),
	capCents: minorUnits("A percentage coupon's largest discount, integer minor units"),
	minSubtotalCents: minorUnits("The minimum cart subtotal, integer minor units"),
	startsAt: instant("When the coupon starts"),
	expiresAt: instant("When the coupon ends"),
	maxUses: count("How many times it can be used in all"),
	maxUsesPerCustomer: count("How many times one customer can use it"),
};

/** A create or edit outcome → success data, or its code. */
function couponAnswer(
	outcome: CouponWriteOutcome<CouponWire>,
	status: "created" | "updated",
	couponId: string,
): unknown {
	switch (outcome.kind) {
		case "ok":
			return { status, coupon: outcome.coupon };
		case "code_taken":
			return toolFailure(
				"COUPON_CODE_TAKEN",
				outcome.taken === "same"
					? "This coupon already exists (likely an earlier create that went through). Nothing was written."
					: "That code or id is already taken. Nothing was written; pick another.",
				{ code: outcome.code, taken: outcome.taken },
			);
		case "currency_refused":
			return toolFailure(
				"COUPON_CURRENCY_REFUSED",
				"The coupon's currency was refused (details.reason says why). Nothing was written.",
				{ reason: outcome.reason, message: outcome.message },
			);
		case "invalid":
			return toolFailure(
				"INVALID_INPUT",
				`The coupon's ${outcome.field} was refused. Nothing was written.`,
				{ field: outcome.field, reason: outcome.reason, message: outcome.message },
			);
		case "not_found":
			return toolFailure("NOT_FOUND", `No coupon with id ${couponId}. Nothing was written.`);
		case "failed":
			return toolFailure("COUPON_WRITE_FAILED", "The coupon was not saved.", {
				status: outcome.status,
			});
		default:
			return unhandled(outcome);
	}
}

export const COUPON_WRITE_TOOLS = [
	defineTool({
		name: "coupons_create",
		description: `Create a discount coupon. A fixed_amount coupon needs \`amountCents\` and \`currency\`; a percentage one needs \`rateBps\` (basis points, 1000 = 10%), and \`currency\` only when it has a cap or minimum spend. Codes are matched case-insensitively and may not contain spaces. Pass your own \`id\` (a UUID) to make a retry safe: a create that already went through then fails COUPON_CODE_TAKEN with details.taken "same". Returns \`{status: "created", coupon}\`. Refusals: COUPON_CODE_TAKEN (details.taken: "code", "id", "same" or "unknown"), COUPON_CURRENCY_REFUSED (details.reason), INVALID_INPUT (details.field), COUPON_WRITE_FAILED. ${MONEY_NOTE}`,
		input: z.object({
			id: z
				.string()
				.min(1)
				.optional()
				.describe("The coupon's id. Defaults to a fresh UUID; pass one to make retries safe."),
			code: z.string().min(1).describe("What shoppers type, e.g. SUMMER10."),
			type: z.enum(COUPON_TYPES),
			currency: z
				.string()
				.length(3)
				.nullable()
				.optional()
				.describe("ISO-4217 code the amounts are in."),
			...economics,
		}),
		async run({ clients, input }) {
			const { id, ...rest } = input;
			const couponId = id ?? crypto.randomUUID();
			const outcome = await createCoupon(clients.rules, { id: couponId, ...rest });
			return couponAnswer(outcome, "created", couponId);
		},
	}),
	defineTool({
		name: "coupons_update",
		description: `Change some of a coupon's fields: send only what changes; every field you leave out is kept, and an explicit null clears that field. The code and type cannot change. This tool cannot change a coupon's currency: \`currency\`, when sent, must be the coupon's current one (a different one fails COUPON_CURRENCY_REFUSED with details.reason "currency_moved"); only an unbound percentage coupon gaining a cap or minimum spend may name a currency, which binds it. Returns \`{status: "updated", coupon}\`. Refusals: NOT_FOUND, COUPON_CURRENCY_REFUSED, INVALID_INPUT (details.field), COUPON_WRITE_FAILED (e.g. clearing a fixed coupon's amount or a percentage coupon's rate). ${MONEY_NOTE}`,
		input: z.object({
			couponId: couponIdInput,
			currency: z
				.string()
				.length(3)
				.nullable()
				.optional()
				.describe("The coupon's current currency (see above)."),
			...economics,
		}),
		async run({ clients, input }) {
			const { couponId, ...fields } = input;
			// `undefined` means "not mentioned" to patchCoupon; drop the keys outright.
			const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
			const outcome = await patchCoupon(clients.rules, couponId, patch);
			return couponAnswer(outcome, "updated", couponId);
		},
	}),
	defineTool({
		name: "coupons_retire",
		description:
			'End a coupon now: it stops applying at checkout from this moment, and its history is kept. Retrying is safe. Returns `{status: "retired", coupon, retiredAt, previous}` (`previous` holds the window it replaced), or `{status: "already_ended"}`. NOT_FOUND for an unknown id.',
		destructive: true,
		input: z.object({ couponId: couponIdInput }),
		async run({ clients, input }) {
			const result = await readOrRefuse(() => retireCoupon(clients.rules, input.couponId));
			if (result.ok) return { status: "retired", ...result.value };
			switch (result.reason) {
				case "already_ended":
					return { status: "already_ended" };
				case "not_found":
					return toolFailure("NOT_FOUND", `No coupon with id ${input.couponId}.`);
				default:
					return unhandled(result.reason);
			}
		},
	}),
	defineTool({
		name: "coupons_delete",
		description:
			'Delete a coupon for good. A coupon that has been redeemed cannot be deleted (COUPON_IN_USE, its redemptions are kept for the record): retire it with coupons_retire instead. Returns `{status: "deleted"}`. NOT_FOUND for an unknown id, including one already deleted.',
		destructive: true,
		input: z.object({ couponId: couponIdInput }),
		async run({ clients, input }) {
			const result = await readOrRefuse(() => deleteCoupon(clients.rules, input.couponId));
			if (result.ok) return { status: "deleted" };
			switch (result.reason) {
				case "not_found":
					return toolFailure(
						"NOT_FOUND",
						`No coupon with id ${input.couponId} (it may already be deleted).`,
					);
				case "in_use":
					return toolFailure(
						"COUPON_IN_USE",
						"The coupon has been redeemed, so it is kept for the record. Use coupons_retire to end it.",
					);
				case "error":
					return toolFailure("COUPON_DELETE_FAILED", "The coupon was not deleted.", {
						status: result.status,
					});
				default:
					return unhandled(result);
			}
		},
	}),
];
