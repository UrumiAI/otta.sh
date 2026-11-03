/**
 * Cash on delivery's two settings (ADR-0044), plain plugin kv beside the Stripe
 * keys, saved from the Payments group of the Store settings page.
 *
 *  - `settings:codEnabled` — the toggle. ONLY a stored `true` turns it on: a
 *    store that never saved it (every store before ADR-0044), a kv miss or any
 *    other value reads as OFF, so existing stores see no change.
 *  - `settings:codInstructions` — optional text shown to the buyer under the
 *    method at checkout and on the order page ("Please have the exact amount
 *    ready"). Plain text, at most {@link COD_INSTRUCTIONS_MAX} characters.
 *
 * Fail-closed wiring: the COD gateway is armed for CHECKOUT only when the toggle
 * is on. The admin side always has it (`resolvePaymentGateways`'s
 * `cashOnDelivery: "always"`), so a COD order placed before the toggle was turned
 * off can still have a manual refund recorded.
 */
import { CashOnDeliveryGateway } from "@urumi.ai/otta-payments-cod";
import type { PluginContext } from "../types.js";

export const COD_ENABLED_KEY = "settings:codEnabled";
export const COD_INSTRUCTIONS_KEY = "settings:codInstructions";
export const COD_INSTRUCTIONS_MAX = 500;

/** Whether the merchant turned cash on delivery on. A kv failure propagates. */
export async function readCodEnabled(ctx: PluginContext): Promise<boolean> {
	return (await ctx.kv.get<unknown>(COD_ENABLED_KEY)) === true;
}

/** The buyer-facing instructions, trimmed, or `null` when none were saved. */
export async function readCodInstructions(ctx: PluginContext): Promise<string | null> {
	const stored = await ctx.kv.get<unknown>(COD_INSTRUCTIONS_KEY);
	if (typeof stored !== "string") return null;
	const trimmed = stored.trim().slice(0, COD_INSTRUCTIONS_MAX);
	return trimmed.length === 0 ? null : trimmed;
}

/** The gateway, when the merchant enabled it (or `always`); else `undefined`. */
export async function codGatewayFromCtx(
	ctx: PluginContext,
	always = false,
): Promise<CashOnDeliveryGateway | undefined> {
	if (always || (await readCodEnabled(ctx))) return new CashOnDeliveryGateway();
	return undefined;
}
