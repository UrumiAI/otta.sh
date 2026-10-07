/**
 * "Background work per minute" — the commerce sweep's per-tick QUERY budget, as
 * an operational setting: its one kv key, its bounds, its presets, its read and
 * its validation.
 *
 * WHY A SETTING AND NOT A CONSTANT. The right budget depends on the Cloudflare
 * plan the store runs on, which only the operator knows: one Worker invocation
 * may make 50 D1 queries on Workers Free and 1000 on Workers Paid (and the
 * host's own scheduled work shares that invocation). A constant sized for Free
 * held a Paid store to a couple of expired holds a minute — QA saw 14–18 due in
 * one tick — and a constant sized for Paid fails every tick on Free.
 *
 * WHY `ctx.kv`, NOT THE OPERATIONAL SETTINGS STORE. It is a fact about the
 * deployment the PLUGIN runs on, not commerce configuration the domain reads —
 * the domain has no notion of a Cloudflare plan — so it sits beside the other
 * plugin-scoped settings (`settings:storeTheme`, `settings:storeDisplayName`).
 * The admin form beside the cart hold TTL is its one writer; the sweep reads it
 * once per tick.
 *
 * NEVER TRUSTED ON READ. A stored value outside the bounds — written by anything
 * but the form — is ignored for the Free default, logged, and never used: a
 * budget above the platform's cap fails the tick with D1's "too many API
 * requests", which is the failure this setting exists to avoid.
 */
import type { PluginContext } from "../types.js";

/** The kv key. */
export const BACKGROUND_WORK_KEY = "settings:backgroundWorkPerMinute";

/**
 * The bounds a saved value must fall within.
 *
 * The FLOOR is the Free preset, and not by taste: below it a critical leg cannot
 * start on any tick — at 20, `expire-holds` gets 11 queries and needs 15 — so a
 * lower setting would stop hold expiry silently and forever. A test pins it
 * against the leg cost table (`minimumQueryBudget` in `sweeps.ts`). The ceiling
 * leaves Workers Paid's 1000 queries per invocation a wide margin for the host's
 * own scheduled work.
 */
export const MIN_BACKGROUND_WORK = 30;
export const MAX_BACKGROUND_WORK = 900;

/** The two choices the form offers, named for the plans they fit. */
export const BACKGROUND_WORK_PRESETS: readonly {
	readonly value: number;
	readonly label: string;
}[] = [
	{ value: 30, label: "Workers Free (30)" },
	{ value: 600, label: "Workers Paid (600)" },
];

/** The default: the Free preset — safe on every plan, and the plan
 *  DEPLOYMENT.md §2 builds for. */
export const DEFAULT_BACKGROUND_WORK = 30;

export type BackgroundWorkValidation =
	| { readonly ok: true; readonly value: number }
	| { readonly ok: false; readonly message: string };

/**
 * Validate a submitted value: a whole number within the bounds, from the form's
 * string (or a number). Refused, never clamped — the same "reject, don't coerce"
 * rule as the cart hold TTL's validation in `@otta-sh/domain`.
 */
export function validateBackgroundWork(raw: unknown): BackgroundWorkValidation {
	const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
	const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < MIN_BACKGROUND_WORK || value > MAX_BACKGROUND_WORK) {
		return {
			ok: false,
			message:
				`Background work per minute must be a whole number from ${String(MIN_BACKGROUND_WORK)}` +
				` to ${String(MAX_BACKGROUND_WORK)} — got ${text === "" ? "nothing" : `"${text}"`}.` +
				" Choose Workers Free (30) unless the store is on Workers Paid.",
		};
	}
	return { ok: true, value };
}

/**
 * The stored value, or the default when there is none, it is unusable, or the
 * read fails. ONE kv read; the sweep makes it through its counted context, so it
 * is part of the budget it sets.
 */
export async function readBackgroundWork(ctx: PluginContext): Promise<number> {
	let stored: unknown;
	try {
		stored = await ctx.kv.get<unknown>(BACKGROUND_WORK_KEY);
	} catch (err) {
		console.error("[otta] background-work setting unreadable; using the Free preset:", err);
		return DEFAULT_BACKGROUND_WORK;
	}
	if (stored === null || stored === undefined) return DEFAULT_BACKGROUND_WORK;
	const checked = validateBackgroundWork(stored);
	if (!checked.ok) {
		console.error(
			`[otta] background-work setting ignored; using the Free preset: ${checked.message}`,
		);
		return DEFAULT_BACKGROUND_WORK;
	}
	return checked.value;
}
