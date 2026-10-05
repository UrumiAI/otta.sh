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
 * EACH PROVIDER HAS ITS OWN KEY SLOT (write-only, `payment-secrets.ts`):
 * Resend keeps `settings:emailApiKey`, SMTP2GO has `settings:emailSmtp2goApiKey`.
 * The sender only ever reads the chosen provider's slot, so a provider switch
 * can never send one provider's live key to the other. See ADR-0005's
 * 2026-10-05 amendment.
 *
 * Readable, not write-only: an operator has to see which provider and region
 * the store uses. Two flat string keys, like the other `settings:*` values, so
 * they fold into one structured `settings:email` document later without a
 * second migration of meaning.
 *
 * FAIL-CLOSED ON THE PROVIDER: unset means the default (Resend), but a read
 * that FAILS, or an unknown stored value, means "no provider" — never a guess,
 * because a guess would hand the wrong provider a key. The region is fail-soft:
 * unset, unreadable or unknown reads as Global.
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

/**
 * Whether the provider dedupes a retried send itself. Resend does (its
 * `Idempotency-Key`, the outbox row id); SMTP2GO defines no idempotency key.
 * For one that does not, a timeout is counted as an attempt
 * (`countTimeoutsAsAttempts`), so a provider that is slow but accepting cannot
 * be handed the same email over and over.
 */
export function providerDedupesRetries(provider: EmailProviderId): boolean {
	return provider === "resend";
}

/**
 * The store's provider choice: the default when unset, `undefined` when the read
 * fails or the stored value is unknown. Never a throw.
 */
export async function readEmailProvider(ctx: PluginContext): Promise<EmailProviderId | undefined> {
	let value: unknown;
	try {
		value = await ctx.kv.get<unknown>(EMAIL_PROVIDER_KEY);
	} catch {
		return undefined;
	}
	if (value === null || value === undefined || value === "") return DEFAULT_EMAIL_PROVIDER;
	if (isEmailProviderId(value)) return value;
	// Only the Settings save writes this key, and it refuses unknown values. One
	// written another way sends nothing rather than guess. Names the key, never
	// the value.
	warnOnce(
		"email-provider-unknown",
		`[otta] ${EMAIL_PROVIDER_KEY} holds an unknown value; email is not sent until a provider is saved in Settings`,
	);
	return undefined;
}

/** The store's SMTP2GO region, never a throw: unset, unreadable or unknown is
 *  Global (each region's host only accepts an SMTP2GO key). */
export async function readSmtp2goRegion(ctx: PluginContext): Promise<Smtp2goRegion> {
	let value: unknown;
	try {
		value = await ctx.kv.get<unknown>(SMTP2GO_REGION_KEY);
	} catch {
		return DEFAULT_SMTP2GO_REGION;
	}
	if (value === null || value === undefined || value === "") return DEFAULT_SMTP2GO_REGION;
	if (isSmtp2goRegion(value)) return value;
	warnOnce(
		"email-smtp2go-region-unknown",
		`[otta] ${SMTP2GO_REGION_KEY} holds an unknown value; using "${DEFAULT_SMTP2GO_REGION}"`,
	);
	return DEFAULT_SMTP2GO_REGION;
}
