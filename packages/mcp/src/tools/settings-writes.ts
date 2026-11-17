/**
 * The settings and payment WRITE tools. Every one calls the plugin's admin
 * settings OPERATION (`packages/plugin/src/admin/operations/settings.ts`), never
 * the surface or kv: the currency switch's confirm step, the operational range
 * checks, the display-name bound, cash on delivery's shorter-window confirm and
 * the payment secrets' shape check and write-only storage are all decided there.
 *
 * A `needs_confirmation` is SUCCESS data — `{status: "needs_confirmation",
 * message, affected, retryWith: {confirmFrom}}` — and nothing was changed: the
 * same call with `confirmFrom` set to what was returned saves (and is refused
 * as STALE if the value it was counted against has moved since).
 *
 * SECRETS. No result, refusal message or `details` carries a payment secret's
 * value or any part of it: the operations' outcomes never hold one, and
 * `payments_set_secret` is `sensitiveInput`, so an input refusal names paths and
 * kinds only.
 */
import {
	clearPaymentSecret,
	saveCashOnDelivery,
	saveOperationalSettings,
	saveStoreCurrency,
	saveStoreDisplayName,
	setPaymentSecret,
	type CashOnDeliveryOutcome,
	type OperationalSettingsWire,
	type PaymentSecretField,
	type StoreCurrencyOutcome,
} from "@urumi.ai/otta-plugin";
import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { defined } from "./common.js";
import { type Complete, type KeysWithin, unhandled } from "./unhandled.js";

/** The payment secrets' field ids — the operation's `PaymentSecretField`
 *  (`PAYMENT_SECRET_STORAGE`'s keys, which `settings_get` reports by). */
const SECRET_FIELDS = [
	"stripeSecretKey",
	"stripeWebhookSecret",
	"webhookEdgeToken",
] as const satisfies readonly PaymentSecretField[];
const secretFieldsComplete: Complete<PaymentSecretField, typeof SECRET_FIELDS> = true;
void secretFieldsComplete;

const secretFieldInput = z
	.enum(SECRET_FIELDS)
	.describe(
		"Which secret: stripeSecretKey (sk_live_… / sk_test_…, or a restricted rk_…), stripeWebhookSecret (whsec_…), or webhookEdgeToken (the edge token, one line, no spaces).",
	);

const NOTHING_CHANGED = "Nothing was changed.";

/** A store-side refusal of a settings save → its code. */
function settingsSaveRefusal(
	outcome: { kind: "superseded"; message: string } | { kind: "unconfirmed" },
): never {
	switch (outcome.kind) {
		case "superseded":
			return toolFailure(
				"SUPERSEDED",
				"Another settings save landed at the same moment, so this one was not applied. Read settings_get and try again.",
				{ message: outcome.message },
			);
		case "unconfirmed":
			return toolFailure(
				"UNCONFIRMED",
				"The store could not say whether the save applied. Read settings_get before trying again.",
			);
		default:
			return unhandled(outcome);
	}
}

function currencyAnswer(outcome: StoreCurrencyOutcome) {
	switch (outcome.kind) {
		case "saved":
			return { status: "saved" as const, currency: outcome.currency };
		case "unchanged":
			return { status: "unchanged" as const, currency: outcome.currency };
		case "needs_confirmation":
			return {
				status: "needs_confirmation" as const,
				message: `${outcome.message} Switching to ${outcome.to} leaves them unbuyable in new carts until they are repriced. ${NOTHING_CHANGED}`,
				affected: outcome.affected,
				retryWith: { confirmFrom: outcome.from },
			};
		case "unsupported":
			return toolFailure(
				"UNSUPPORTED_CURRENCY",
				`${outcome.currency} is not a currency the store supports. ${NOTHING_CHANGED}`,
				{ currency: outcome.currency },
			);
		case "settings_unreadable":
			return toolFailure(
				"SETTINGS_UNREADABLE",
				`The settings could not be read, so the switch could not be checked. ${NOTHING_CHANGED}`,
			);
		case "stale":
			return toolFailure(
				"STALE",
				`The store currency is no longer the confirmFrom you sent (it changed since you were asked). Call again without confirmFrom. ${NOTHING_CHANGED}`,
			);
		case "count_failed":
			return toolFailure(
				"COUNT_FAILED",
				`The products priced in ${outcome.from} could not be counted, so the switch could not be checked. ${NOTHING_CHANGED}`,
				{ from: outcome.from },
			);
		case "superseded":
		case "unconfirmed":
			return settingsSaveRefusal(outcome);
		default:
			return unhandled(outcome);
	}
}

function codAnswer(outcome: CashOnDeliveryOutcome) {
	switch (outcome.kind) {
		case "saved":
			return { status: "saved" as const, enabled: outcome.enabled };
		case "needs_confirmation":
			return {
				status: "needs_confirmation" as const,
				message: `${outcome.message} ${NOTHING_CHANGED}`,
				affected: outcome.affected,
				retryWith: { confirmFrom: outcome.from },
			};
		case "invalid":
			return toolFailure("INVALID_INPUT", `${outcome.message} ${NOTHING_CHANGED}`, {
				message: outcome.message,
			});
		case "window_unreadable":
			return toolFailure(
				"WINDOW_UNREADABLE",
				`The stored auto-cancel window could not be read, so the change could not be checked. ${NOTHING_CHANGED}`,
			);
		case "stale":
			return toolFailure(
				"STALE",
				`The auto-cancel window is no longer the confirmFrom you sent (it changed since you were asked). Call again without confirmFrom. ${NOTHING_CHANGED}`,
			);
		case "count_failed":
			return toolFailure(
				"COUNT_FAILED",
				`The unpaid orders the shorter window would cancel could not be counted. ${NOTHING_CHANGED}`,
			);
		default:
			return unhandled(outcome);
	}
}

const operationalInput = z
	.object({
		holdTtlMinutes: z
			.number()
			.int()
			.optional()
			.describe("How long a cart holds its stock, in whole minutes (1-10080)."),
		lowStockThreshold: z
			.number()
			.int()
			.optional()
			.describe("Stock (units) at or below which a product counts as low stock (0 or more)."),
		showHoldTimer: z.boolean().optional().describe("Whether shoppers see the cart hold countdown."),
	})
	.strict();
const operationalKeysKnown: KeysWithin<
	z.infer<typeof operationalInput>,
	OperationalSettingsWire
> = true;
void operationalKeysKnown;

const codInput = z
	.object({
		enabled: z.boolean().describe("Whether checkout offers cash on delivery."),
		autoCancelDays: z
			.number()
			.int()
			.optional()
			.describe(
				"Cancel unpaid cash-on-delivery orders after this many days (0-365; 0 never cancels). Left out: kept.",
			),
		maxOpenPerBuyer: z
			.number()
			.int()
			.optional()
			.describe("Most unpaid orders one buyer email may hold (0-100, 0 = no cap). Left out: kept."),
		maxOpenPerClient: z
			.number()
			.int()
			.optional()
			.describe("Most unpaid orders one network may hold (0-100, 0 = no cap). Left out: kept."),
		maxUnitsPerOrder: z
			.number()
			.int()
			.optional()
			.describe("Most items in one order (0-1000, 0 = no cap). Left out: kept."),
		instructions: z
			.string()
			.optional()
			.describe(
				"What buyers are told about paying on delivery; blank clears them. Left out: kept.",
			),
		confirmFrom: z
			.number()
			.int()
			.optional()
			.describe(
				"Only after a needs_confirmation answer: its retryWith.confirmFrom, unchanged. Omit otherwise.",
			),
	})
	.strict();

/** The operation's `numbers`, keyed by form field (`COD_NUMBER_SETTINGS`). */
const COD_NUMBER_FIELDS = {
	autoCancelDays: "codAutoCancelDays",
	maxOpenPerBuyer: "codMaxOpenPerBuyer",
	maxOpenPerClient: "codMaxOpenPerClient",
	maxUnitsPerOrder: "codMaxUnitsPerOrder",
} as const;

export const SETTINGS_WRITE_TOOLS = [
	defineTool({
		name: "settings_update",
		description:
			'Change the store\'s operational settings: cart hold time (minutes), low-stock threshold (units) and whether shoppers see the hold countdown. Send only what changes; a field you leave out is kept. All or nothing: one value out of range refuses the whole save. Returns `{status: "saved", settings}` as now in force. Refusals: INVALID_INPUT (details.problems names each field; also an unknown key, or nothing to change), REJECTED, SUPERSEDED, UNCONFIRMED. The currency has its own tool, settings_update_currency.',
		input: operationalInput,
		async run({ clients, input }) {
			const values = defined(input);
			if (Object.keys(values).length === 0) {
				return toolFailure(
					"INVALID_INPUT",
					"nothing to change: send `holdTtlMinutes`, `lowStockThreshold`, `showHoldTimer` or a combination.",
				);
			}
			const outcome = await saveOperationalSettings(clients.reporting, values);
			switch (outcome.kind) {
				case "saved":
					return { status: "saved", settings: outcome.settings };
				case "invalid":
					return toolFailure(
						"INVALID_INPUT",
						`${outcome.problems.map((p) => `${p.field}: ${p.message}`).join("; ")} ${NOTHING_CHANGED}`,
						{ problems: outcome.problems },
					);
				case "rejected":
					return toolFailure("REJECTED", `The store refused the settings. ${NOTHING_CHANGED}`, {
						message: outcome.message,
					});
				case "superseded":
				case "unconfirmed":
					return settingsSaveRefusal(outcome);
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "settings_update_store_name",
		description:
			'Set the store\'s display name (shown to buyers and in emails), trimmed, 1-200 characters. Returns `{status: "saved", name}`. Refusals: INVALID_INPUT.',
		input: z.object({ name: z.string().describe("The display name.") }).strict(),
		async run({ ctx, input }) {
			const outcome = await saveStoreDisplayName(ctx, input.name);
			switch (outcome.kind) {
				case "saved":
					return { status: "saved", name: outcome.name };
				case "invalid":
					return toolFailure(
						"INVALID_INPUT",
						`name: must be 1-${String(outcome.max)} characters once trimmed. ${NOTHING_CHANGED}`,
						{ field: "name", max: outcome.max },
					);
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "settings_update_currency",
		description:
			'Set the currency (ISO-4217, e.g. EUR) new carts are created in. Products keep their own currency, so when products are priced in the current currency the first call answers `{status: "needs_confirmation", message, affected, retryWith: {confirmFrom}}` and changes nothing: tell the merchant, then call again with that confirmFrom. Returns `{status: "saved", currency}` or `{status: "unchanged", currency}`. Refusals: UNSUPPORTED_CURRENCY, STALE (the currency moved since you were asked), SETTINGS_UNREADABLE, COUNT_FAILED, SUPERSEDED, UNCONFIRMED, INVALID_INPUT.',
		input: z
			.object({
				currency: z.string().min(1).describe("ISO-4217 code, upper case, e.g. EUR."),
				confirmFrom: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Only after a needs_confirmation answer: its retryWith.confirmFrom, unchanged. Omit otherwise.",
					),
			})
			.strict(),
		async run({ ctx, clients, input }) {
			const outcome = await saveStoreCurrency(ctx, clients.reporting, {
				currency: input.currency,
				...(input.confirmFrom === undefined ? {} : { confirm: { from: input.confirmFrom } }),
			});
			return currencyAnswer(outcome);
		},
	}),
	defineTool({
		name: "payments_cod_set_enabled",
		description:
			'Turn cash on delivery on or off, and optionally change its auto-cancel window (days), caps and buyer instructions; a field you leave out is kept. All or nothing. LOWERING the window cancels the open unpaid orders older than it on the next sweep, so when any would be, the first call answers `{status: "needs_confirmation", message, affected, retryWith: {confirmFrom}}` and changes nothing: tell the merchant, then call again with that confirmFrom. Returns `{status: "saved", enabled}`. Refusals: INVALID_INPUT, STALE (the window moved since you were asked), WINDOW_UNREADABLE, COUNT_FAILED.',
		input: codInput,
		destructive: true,
		async run({ ctx, input }) {
			const numbers: Record<string, number> = {};
			for (const [key, field] of Object.entries(COD_NUMBER_FIELDS)) {
				const value = input[key as keyof typeof COD_NUMBER_FIELDS];
				if (value !== undefined) numbers[field] = value;
			}
			const outcome = await saveCashOnDelivery(ctx, {
				enabled: input.enabled,
				numbers,
				...(input.instructions === undefined ? {} : { instructions: input.instructions }),
				...(input.confirmFrom === undefined ? {} : { confirm: { from: input.confirmFrom } }),
			});
			return codAnswer(outcome);
		},
	}),
	defineTool({
		name: "payments_set_secret",
		description:
			'Store a payment secret, write-only and encrypted at rest. The value is never returned by any tool: settings_get then reports it as "set". The value is trimmed and must be the shape the provider issues. Returns `{status: "saved", field}`. Refusals: INVALID_INPUT (wrong shape — the message names the shape, never the value; the secret already stored stays), BLANK (nothing stored; to remove one use payments_clear_secret), ENCRYPTION_UNAVAILABLE (the host has no usable encryption key, so nothing was stored), WRITE_FAILED.',
		input: z
			.object({
				field: secretFieldInput,
				value: z.string().describe("The secret, exactly as the provider issued it."),
			})
			.strict(),
		destructive: true,
		sensitiveInput: true,
		async run({ ctx, input }) {
			// The operation's outcomes carry no value; neither does anything said here.
			const outcome = await setPaymentSecret(ctx, input.field, input.value);
			switch (outcome.kind) {
				case "saved":
					return { status: "saved", field: input.field };
				case "invalid":
					return toolFailure(
						"INVALID_INPUT",
						`${input.field} ${outcome.problem}. Nothing was stored; the secret already stored stays.`,
						{ field: input.field, problem: outcome.problem },
					);
				case "blank":
					return toolFailure(
						"BLANK",
						"The value is blank, so nothing was stored (a stored secret is kept). To remove one, use payments_clear_secret.",
						{ field: input.field },
					);
				case "unknown_field":
					return toolFailure("UNKNOWN_FIELD", "Not a payment secret field.", {
						field: input.field,
					});
				case "encryption_unavailable":
					return toolFailure(
						"ENCRYPTION_UNAVAILABLE",
						"The host has no usable EMDASH_ENCRYPTION_KEY, so the secret could not be stored encrypted. Nothing was stored.",
						{ field: input.field },
					);
				case "write_failed":
					return toolFailure(
						"WRITE_FAILED",
						"The host refused to store the secret. Nothing was stored.",
						{ field: input.field },
					);
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "payments_clear_secret",
		description:
			'Remove a stored payment secret on purpose (also the way out of one this site cannot read). Checkout stops using it at once. Returns `{status: "cleared", field}`. Refusals: NOT_STORED (nothing was stored), INVALID_INPUT.',
		input: z.object({ field: secretFieldInput }).strict(),
		destructive: true,
		sensitiveInput: true,
		async run({ ctx, input }) {
			const outcome = await clearPaymentSecret(ctx, input.field);
			switch (outcome.kind) {
				case "cleared":
					return { status: "cleared", field: input.field };
				case "not_stored":
					return toolFailure(
						"NOT_STORED",
						"No secret is stored in that field; nothing was removed.",
						{
							field: input.field,
						},
					);
				case "unknown_field":
					return toolFailure("UNKNOWN_FIELD", "Not a payment secret field.", {
						field: input.field,
					});
				default:
					return unhandled(outcome);
			}
		},
	}),
];
