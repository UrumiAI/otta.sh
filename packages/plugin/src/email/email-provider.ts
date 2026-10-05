/**
 * Which email provider a store sends through — a Settings choice, in READABLE kv.
 *
 * TWO PROVIDERS, AND THE DEFAULT IS TODAY'S BEHAVIOUR.
 *  - `resend` (the default): the Resend-shaped sender posting to the build's
 *    `EMAIL_API_URL` (`CtxHttpEmailSender`). A store that never saves this
 *    setting sends exactly as before.
 *  - `smtp2go`: SMTP2GO's send API, on the region the store picks
 *    (`Smtp2goEmailSender`). Its hosts are granted in every build
 *    (`SMTP2GO_API_HOSTS` in `manifest.ts`), so it needs no build-time URL.
 *
 * THE KEY IS THE SAME SECRET SLOT for both, `settings:emailApiKey`: a store
 * sends through one provider at a time, and the slot is "the active
 * provider's key". See ADR-0005's 2026-10-05 amendment for why it is not a
 * second slot.
 *
 * Readable, not write-only: an operator has to see which provider and region
 * the store uses. Two flat string keys, like the other `settings:*` values, so
 * they fold into one structured `settings:email` document later without a
 * second migration of meaning.
 *
 * FAIL-SOFT: an unset, unreadable or unknown stored value reads as the default
 * — an unknown one is logged once — so a kv blip never stops mail.
 */
import { SMTP2GO_API_HOSTS } from "../manifest.js";
import type { PluginContext } from "../types.js";
import { warnOnce } from "./http-email-sender.js";

/** The provider choice. */
export const EMAIL_PROVIDER_KEY = "settings:emailProvider";

/** SMTP2GO's region. Read only when the provider is SMTP2GO. */
export const SMTP2GO_REGION_KEY = "settings:emailSmtp2goRegion";

export const EMAIL_PROVIDERS = ["resend", "smtp2go"] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDERS)[number];
export const DEFAULT_EMAIL_PROVIDER: EmailProviderId = "resend";

export type Smtp2goRegion = keyof typeof SMTP2GO_API_HOSTS;
export const SMTP2GO_REGIONS = Object.keys(SMTP2GO_API_HOSTS) as Smtp2goRegion[];
export const DEFAULT_SMTP2GO_REGION: Smtp2goRegion = "global";

export function isEmailProviderId(value: unknown): value is EmailProviderId {
	return typeof value === "string" && (EMAIL_PROVIDERS as readonly string[]).includes(value);
}

export function isSmtp2goRegion(value: unknown): value is Smtp2goRegion {
	return typeof value === "string" && Object.hasOwn(SMTP2GO_API_HOSTS, value);
}

/** SMTP2GO's send endpoint for a region. */
export function smtp2goSendUrl(region: Smtp2goRegion): string {
	return `https://${SMTP2GO_API_HOSTS[region]}/v3/email/send`;
}

/** The store's provider choice, never a throw. */
export async function readEmailProvider(ctx: PluginContext): Promise<EmailProviderId> {
	return readChoice(ctx, EMAIL_PROVIDER_KEY, isEmailProviderId, DEFAULT_EMAIL_PROVIDER);
}

/** The store's SMTP2GO region, never a throw. */
export async function readSmtp2goRegion(ctx: PluginContext): Promise<Smtp2goRegion> {
	return readChoice(ctx, SMTP2GO_REGION_KEY, isSmtp2goRegion, DEFAULT_SMTP2GO_REGION);
}

async function readChoice<T extends string>(
	ctx: PluginContext,
	key: string,
	valid: (value: unknown) => value is T,
	fallback: T,
): Promise<T> {
	let value: unknown;
	try {
		value = await ctx.kv.get<unknown>(key);
	} catch {
		return fallback;
	}
	if (value === null || value === undefined || value === "") return fallback;
	if (valid(value)) return value;
	// Only the Settings save writes this key, and it refuses unknown values; one
	// written another way is used as the default, and said once. The message
	// names the key, never the value.
	warnOnce(`email-choice-${key}`, `[otta] ${key} holds an unknown value; using "${fallback}"`);
	return fallback;
}
