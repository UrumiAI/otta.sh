import {
	BACKGROUND_WORK_KEY,
	BACKGROUND_WORK_PRESETS,
	readBackgroundWork,
	validateBackgroundWork,
} from "../cron/background-work-setting.js";
import { MAX_HOLD_TTL_MINUTES } from "@otta-sh/domain";
import { EMAIL_FROM_KEY } from "../email/ctx-http-email-sender.js";
import { STORE_DISPLAY_NAME_KEY } from "../email/email-render-context.js";
import { isDeliverableFromAddress } from "../email/from-address.js";
import { isPlausiblePayTo, X402_ACCEPTS_KEY, X402_PAYTO_KEY } from "../payments/x402-wiring.js";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import {
	checkEmailApiKey,
	checkOpaqueToken,
	checkStripeSecretKey,
	checkStripeWebhookSecret,
	isResendApiUrl,
	type SecretShapeCheck,
	stripeKeyMode,
} from "../payment-secret-shapes.js";
import {
	isSavableLoginLinkUrl,
	isValidLoginLinkUrl,
	LOGIN_LINK_URL_KEY,
} from "../storefront/login-link.js";
import {
	EMAIL_API_KEY_KEY,
	readWriteOnlySecret,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
	X402_FACILITATOR_API_KEY_KEY,
	X402_LEGACY_FACILITATOR_SECRET_KEY,
} from "../payment-secrets.js";
import type {
	AccordionBlock,
	AdminPageConfig,
	Block,
	BlockResponse,
	FormBlock,
	PluginContext,
	RouteHandler,
	SettingsFieldSpec,
} from "../types.js";
import { MAX_LOW_STOCK_THRESHOLD } from "./in-process-reporting-settings-client.js";
import { makeAdminClients } from "./make-admin-clients.js";
import type {
	OperationalSettingsWire,
	ReportingSettingsSurface,
} from "./reporting-settings-surface.js";
import { carriedForm, noticeBanner, type Notice } from "./scaffold/index.js";

/**
 * The admin Settings screen (§4.1 report/settings skeleton;
 * `docs/admin/ADMIN-CONSOLE.md` §12.6) — ONE page, THREE named groups, THREE
 * save paths made visible, not hidden:
 *  - `storeDisplayName` (kv tier, "Store" group) saves via `ctx.kv.set`.
 *  - `holdTtlMinutes` / `lowStockThreshold` (operational tier, "Checkout &
 *    holds" group) save through the reporting/settings client `makeAdminClients`
 *    hands back. Since INC-D3a that is ALWAYS the in-process client writing this
 *    plugin's own store — no HTTP hop, no token — and its validation rejection
 *    is surfaced INLINE (never swallowed), read from the structural `reason`
 *    rather than from an HTTP status the in-process tier does not have.
 *  - the write-only payment/email credentials ("Payments & email" group) save
 *    into write-only plugin kv, one key per secret ({@link PAYMENT_SECRET_FIELDS}).
 *  - "Background work per minute" (in "Checkout & holds", beside the hold TTL)
 *    saves the commerce sweep's per-tick query budget into plugin kv — a
 *    deployment fact (the Cloudflare plan), not domain configuration; see
 *    `cron/background-work-setting.ts`.
 *
 * RETIRED (work order 02, INC-D3a): this screen used to carry a FOURTH
 * "Service connection" group with two more write-only secret forms —
 * `internalToken` (`X-Internal-Token`, the token the guarded `/reports/*`
 * reads and the privileged `PUT /settings` needed) and `serviceToken`
 * (`X-Service-Token`, ADR-0007's machine write-gate the service enforced on
 * every non-GET). Both existed to authenticate THIS plugin to the standalone
 * `@otta-sh/service` package (now deleted) as a separate deployable. Now that
 * the commerce service is folded into the plugin (ADR-0014/0015) there is
 * nothing left on the other side of that call to authenticate to, so both
 * tokens, their kv keys,
 * their save-generation counters, and the group that held their forms are
 * gone outright rather than kept as dead provisioning UI. The INC-09
 * write-only, never-masked discipline they pioneered survives below in
 * {@link paymentsGroup} — the credentials that still need it.
 *
 * S-5 / S-4: every save re-renders the FULL screen (all three accordions) plus
 * a notice banner — never a fragment. Two live bugs this fixes (§12.6):
 * `save-display`'s success path used to return `[header, section]` (every other
 * form vanished, and since the host's `page_load` effect never re-fires
 * on its own, the operator had to navigate away to recover — the receipt was
 * terminal), and the invalid-name branch used to return `[header, banner]`
 * with no field to correct. Both branches now go through {@link renderPage}.
 */
export const SETTINGS_PAGE: AdminPageConfig = {
	path: "/settings",
	label: "Settings",
	icon: "settings",
};

/** The kv key for the store display name (`settings:*` = the em-dash
 *  convention for user-configurable prefs shown in admin UI). Defined beside the
 *  email sender, which names the store in the sign-in email. */
export { STORE_DISPLAY_NAME_KEY };

/** The "Background work per minute" form's submit — a kv save. */
const SAVE_BACKGROUND_WORK_ACTION = "save-background-work";

/** Current save generation for a token key, defaulting to 0 when never saved.
 *  FAIL-SOFT (INC-C3): a kv read that REJECTS degrades to 0 rather than taking
 *  the whole render down — the generation only forces a field to remount blank,
 *  so getting it wrong costs a stale-looking input, while throwing would lock an
 *  operator out of the one screen they would use to re-provision. */
async function readSaveGen(ctx: PluginContext, key: string): Promise<number> {
	try {
		return (await ctx.kv.get<number>(key)) ?? 0;
	} catch {
		return 0;
	}
}

/**
 * INC-C3 — the payment/email secrets, as ONE table driving everything: the save
 * branches, the forms, the group label and the action-id set. One row per
 * secret, so adding a fifth cannot half-land.
 *
 * Every `kvKey` is the in-process equivalent of an environment variable the
 * standalone `@otta-sh/service` used to read (see `payment-secrets.ts` for the
 * env-var → kv-key table and the
 * source lines). `genKey` is this secret's own save generation, independent per
 * secret so saving one never blanks another's untouched field — see
 * {@link bumpSaveGen}.
 */
interface SecretFieldSpec {
	/** Dispatch id; also a member of {@link SETTINGS_ACTION_IDS}. */
	actionId: string;
	/** The submitted value's `action_id` (and this secret's name in prose). */
	fieldId: string;
	/** Write-only kv key holding the secret. */
	kvKey: string;
	/** Write-only kv key holding this secret's save generation. */
	genKey: string;
	/** Field label — names the credential, never any part of its value. The
	 *  field shows it with "— set" / "— not set" after it. */
	label: string;
	/** What notices, toasts and the submit button call it, capitalised as the
	 *  operator reads it ("Stripe secret key"). */
	noun: string;
	/** The placeholder while nothing is stored: the shape to paste. */
	hint: string;
	/** U-8: trim, then check the shape the provider issues. The trimmed value is
	 *  what is stored; the reason names the shape, never the value. */
	check: (raw: string) => SecretShapeCheck;
	/** What stops working when this key is removed — the confirm dialog's text. */
	removeEffect: string;
	/** The shape, as visible help text above the field (a set key's placeholder
	 *  no longer shows it). */
	shapeHelp: string;
	/** Where the operator finds the key again — named after a Remove. */
	whereToFind: string;
}

const PAYMENT_SECRET_FIELDS: readonly SecretFieldSpec[] = [
	{
		actionId: "save-stripe-secret-key",
		fieldId: "stripeSecretKey",
		kvKey: STRIPE_SECRET_KEY_KEY,
		genKey: "settings:stripeSecretKeyGen",
		label: "Stripe secret key",
		noun: "Stripe secret key",
		hint: "sk_live_… or sk_test_…",
		check: checkStripeSecretKey,
		removeEffect: "Card payments and refunds stop working until a new key is saved.",
		shapeHelp:
			"Starts with sk_live_ or sk_test_ (rk_live_ / rk_test_ for a restricted key). Not the publishable pk_ key.",
		whereToFind: "Stripe Dashboard → Developers → API keys",
	},
	{
		actionId: "save-stripe-webhook-secret",
		fieldId: "stripeWebhookSecret",
		kvKey: STRIPE_WEBHOOK_SECRET_KEY,
		genKey: "settings:stripeWebhookSecretGen",
		label: "Stripe webhook signing secret",
		noun: "Stripe webhook signing secret",
		hint: "whsec_…",
		check: checkStripeWebhookSecret,
		shapeHelp: "Starts with whsec_ — the signing secret of your webhook endpoint.",
		whereToFind:
			"your webhook endpoint in the Stripe Dashboard (Developers or Workbench → Webhooks) → Signing secret",
		removeEffect:
			"Card orders stop being marked paid when Stripe reports a payment, until a new secret is saved.",
	},
	{
		actionId: "save-email-api-key",
		fieldId: "emailApiKey",
		kvKey: EMAIL_API_KEY_KEY,
		genKey: "settings:emailApiKeyGen",
		label: "Email provider API key",
		noun: "Email API key",
		hint: isResendApiUrl(IN_PROCESS_EGRESS_URLS.emailApiUrl)
			? "re_…"
			: "Your email provider's API key",
		// Which provider the store sends through is fixed at build time
		// (`IN_PROCESS_EGRESS_URLS`), so the shape is too.
		check: (raw) => checkEmailApiKey(raw, IN_PROCESS_EGRESS_URLS.emailApiUrl),
		removeEffect: "Order and sign-in emails stop sending until a new key is saved.",
		shapeHelp: isResendApiUrl(IN_PROCESS_EGRESS_URLS.emailApiUrl)
			? "Starts with re_ — a Resend API key."
			: "Your email provider's API key: one line, no spaces.",
		whereToFind: isResendApiUrl(IN_PROCESS_EGRESS_URLS.emailApiUrl)
			? "Resend → API Keys"
			: "your email provider's dashboard",
	},
	{
		actionId: "save-x402-facilitator-secret",
		fieldId: "x402FacilitatorSecret",
		kvKey: X402_FACILITATOR_API_KEY_KEY,
		genKey: "settings:x402FacilitatorApiKeyGen",
		// INC-C5 renamed the FIELD, the kv key AND the generation key, because the
		// meaning changed: in-process the value is the bearer credential the
		// facilitator call SENDS, not the offline HMAC secret INC-C3's label
		// described. An operator who provisioned under the old label holds a
		// forge-a-settlement secret this increment would hand to a third-party
		// host, so the old value must not be inherited — the new key names make
		// the field read as unset until it is deliberately re-provisioned (review
		// round 2, A5).
		label: "x402 facilitator API key",
		noun: "x402 facilitator API key",
		hint: "Your x402 facilitator's API key",
		check: checkOpaqueToken,
		// ADR-0028 increment 2: nothing reads this key until the x402 content gate
		// ships, so the copy must not claim a removal breaks anything today.
		removeEffect:
			"Nothing uses this key yet. x402 payments are not available until x402 support ships.",
		shapeHelp: "Your x402 facilitator's API key: one line, no spaces.",
		whereToFind: "your x402 facilitator's dashboard",
	},
	{
		// INC-C1b. Not a renamed service env var like the four above — it is the
		// shared edge token the site attaches (`X-Otta-Wh-Token`) to a Stripe
		// webhook it forwards to the plugin's `webhooks/stripe/settle` route. It
		// gets the identical write-only treatment because it is a shared secret,
		// and it is provisioned HERE because this is the only screen an operator
		// has. Leaving it unset is a supported configuration (the route falls back
		// to Stripe-HMAC-only), which is why its label says optional and the group
		// label leaves it out.
		actionId: "save-webhook-edge-token",
		fieldId: "webhookEdgeToken",
		kvKey: WEBHOOK_EDGE_TOKEN_KEY,
		genKey: "settings:otta-wh-tokenGen",
		label: "Stripe webhook edge token (optional)",
		noun: "Webhook edge token",
		hint: "The token your storefront sends with Stripe webhooks",
		check: checkOpaqueToken,
		removeEffect:
			"Stripe webhooks are then checked by their Stripe signature alone, which still refuses forgeries.",
		shapeHelp:
			"Optional. The token your storefront sends with Stripe webhooks: one line, no spaces.",
		whereToFind: "your storefront's deployment settings",
	},
];

/** Look a secret up by the field id a Remove button carries. */
function secretSpecByField(fieldId: unknown): SecretFieldSpec | undefined {
	return PAYMENT_SECRET_FIELDS.find((spec) => spec.fieldId === fieldId);
}

/** U-8: the Remove button's action. ONE id for every secret — the button's
 *  `value` names which (`{ secret: <fieldId> }`), the only context a button
 *  can carry. */
export const CLEAR_PAYMENT_SECRET_ACTION = "clear-payment-secret";

/**
 * INC-C5 — the NON-SECRET companions of the four secrets above: the in-process
 * equivalents of the service's `EMAIL_FROM`, `X402_PAYTO` and `X402_ACCEPTS`
 * env vars.
 *
 * WHY THEY ARE A SEPARATE TABLE AND A SEPARATE FORM. They are a different TIER,
 * and the difference is visible: these are READ BACK into the field, because an
 * operator must be able to see which address they are being paid at and which
 * from-address their customers see. A secret rendered back is a bug; a
 * configuration value NOT rendered back is also a bug. One form for all three
 * because they are saved together and none of them is independently useful —
 * and because the alternative, three more submit buttons, would make the group
 * unreadable.
 *
 * WHY THEY EXIST AT ALL (review A3/B5): INC-C3 shipped the four secrets without
 * them, which left `settings:x402PayTo` with no writer anywhere in the product.
 * `x402GatewayFromCtx` fail-closes without it, so x402 was inert in EVERY
 * deployment regardless of how it was provisioned.
 */
export const SAVE_PAYMENT_SETTINGS_ACTION = "save-payment-settings";

interface PlainSettingSpec {
	/** The submitted value's `action_id`, and the field's id. */
	fieldId: string;
	/** Readable kv key. */
	kvKey: string;
	label: string;
	placeholder: string;
}

const PLAIN_PAYMENT_SETTINGS: readonly PlainSettingSpec[] = [
	{
		fieldId: "emailFrom",
		kvKey: EMAIL_FROM_KEY,
		label: "Order email from-address",
		// A placeholder the save ACCEPTS. It used to be the runtime default,
		// `no-reply@otta.local` — a reserved domain no provider sends from, which
		// the save now refuses (`email/from-address.ts`). Shows the display-name
		// form because that is what customers read in their inbox.
		placeholder: "Your Shop <orders@yourdomain.com>",
	},
	// Issue #306 — where the emailed sign-in link points, and the ONLY place it may
	// point: required for customer login (unset ⇒ no link is sent). Read back for
	// the same reason as the from-address. Adapted from #325 by @stephanedemotte.
	{
		fieldId: "loginLinkUrl",
		kvKey: LOGIN_LINK_URL_KEY,
		label: "Sign-in page address (your storefront's /account/verify page)",
		placeholder: "https://shop.example/account/verify",
	},
	{
		fieldId: "x402PayTo",
		kvKey: X402_PAYTO_KEY,
		label: "x402 destination wallet",
		placeholder: "0x… (the address buyers pay)",
	},
	{
		fieldId: "x402Accepts",
		kvKey: X402_ACCEPTS_KEY,
		label: "x402 networks, comma-separated",
		placeholder: "eip155:8453",
	},
];

/** The payment/email secret action ids — a subset of {@link SETTINGS_ACTION_IDS},
 *  exported so a dispatcher (or a test) can name this group without restating
 *  the strings. */
export const PAYMENT_SECRET_ACTION_IDS: ReadonlySet<string> = new Set(
	PAYMENT_SECRET_FIELDS.map((spec) => spec.actionId),
);

/** What the "Payments & email" group renders from: per secret, whether it is SET
 *  (a fact ABOUT the credential — never any part of it) and its save generation.
 *  The VALUES stop inside {@link readPaymentSecretState} and never travel. */
interface SecretRenderState {
	set: boolean;
	gen: number;
	/** U-8: test or live, for the Stripe secret key only — read from the key's
	 *  prefix, which says which Stripe mode checkout runs in and nothing about
	 *  the key itself. `undefined` for every other secret, or a Stripe key saved
	 *  before shapes were checked. */
	mode?: "test" | "live";
}

/** Read the render state for every payment secret. FAIL-CLOSED per secret
 *  (`readWriteOnlySecret` swallows a rejection to `undefined`), so a kv outage
 *  renders "not set" — an honest understatement that still leaves the form
 *  usable — rather than throwing out of the page load. */
async function readPaymentSecretState(ctx: PluginContext): Promise<Map<string, SecretRenderState>> {
	const entries = await Promise.all(
		PAYMENT_SECRET_FIELDS.map(async (spec) => {
			const [value, gen] = await Promise.all([
				readWriteOnlySecret(ctx, spec.kvKey),
				readSaveGen(ctx, spec.genKey),
			]);
			const mode =
				spec.kvKey === STRIPE_SECRET_KEY_KEY && value !== undefined
					? stripeKeyMode(value)
					: undefined;
			const state: SecretRenderState =
				mode === undefined ? { set: value !== undefined, gen } : { set: true, gen, mode };
			return [spec.kvKey, state] as const;
		}),
	);
	return new Map(entries);
}

/** Everything this screen renders that comes out of `ctx.kv` — read ONCE per
 *  handler invocation (INC-15). */
interface SettingsPageState {
	displayName: string;
	/** INC-C3: per payment secret, "is it set" + its save generation, keyed by kv
	 *  key. NEVER the values — see {@link readPaymentSecretState}. */
	paymentSecrets: Map<string, SecretRenderState>;
	/** INC-C5: the NON-secret payment/email settings, keyed by kv key. These ARE
	 *  the values, and they are rendered back — that is the tier difference. */
	plainSettings: Map<string, string>;
	/** The commerce sweep's per-tick query budget ("Background work per minute"),
	 *  as the sweep would read it — the default when unset or unusable. */
	backgroundWork: number;
}

/** Read the three non-secret payment/email settings. FAIL-SOFT per key, for the
 *  same reason as everything else on this screen: a kv blip must leave the forms
 *  usable rather than deny the operator the only provisioning surface there is. */
async function readPlainSettings(ctx: PluginContext): Promise<Map<string, string>> {
	const entries = await Promise.all(
		PLAIN_PAYMENT_SETTINGS.map(async (spec) => {
			const value = await ctx.kv.get<string>(spec.kvKey).catch(() => null);
			return [spec.kvKey, typeof value === "string" ? value : ""] as const;
		}),
	);
	return new Map(entries);
}

/**
 * The kv half of a render.
 *
 * INC-D3a: this used to also take the two connection tokens the handler had
 * read at the top of the request, folded in so the (now-deleted) "Service
 * connection" group's booleans could be derived from them rather than re-read
 * (that was INC-15's whole point: two of what used to be 7 sequential kv gets
 * were redundant re-reads). With both tokens gone — the commerce service they
 * authenticated to is gone — there is nothing left to derive from a
 * caller-supplied argument, so this reads everything itself: the display name,
 * the payment-secret state, the plain payment settings and the background-work
 * budget: four concurrent gets.
 */
async function readPageState(ctx: PluginContext): Promise<SettingsPageState> {
	const [displayName, paymentSecrets, plainSettings, backgroundWork] = await Promise.all([
		// FAIL-SOFT alongside the rest (INC-C3): the display name is cosmetic, and
		// a kv blip on it must not deny the operator the secret forms below.
		ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY).catch(() => null),
		readPaymentSecretState(ctx),
		readPlainSettings(ctx),
		// Fail-soft inside (a kv blip reads as the default), and the SAME read the
		// sweep makes, so the form shows the budget the next tick will use.
		readBackgroundWork(ctx),
	]);
	return {
		backgroundWork,
		plainSettings,
		displayName: displayName ?? "",
		paymentSecrets,
	};
}

/** The receipt for a payment-secret submit: a blank submit persists nothing
 *  and must not claim it did — the field is always blank on mount (INC-09)
 *  and a blank submit deliberately keeps the stored secret, so the honest
 *  receipt for that path says nothing was entered. Names the credential,
 *  never any part of its value. */
function secretNotice(spec: SecretFieldSpec, entered: boolean): Notice {
	return entered
		? {
				variant: "default",
				title: `${spec.noun} saved`,
				description: `The ${lowerFirst(spec.noun)} was saved. It won't be shown again.`,
			}
		: {
				variant: "default",
				title: `Nothing entered — ${spec.noun} unchanged`,
				description: `The field was blank, so the ${lowerFirst(spec.noun)} you saved before was kept. Enter a new one to replace it.`,
			};
}

/** `https://user:pw@host/…` → `https://host/…`, leaving the rest as typed. */
function withoutUserInfo(url: string): string {
	return url.replace(/^(\s*[a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");
}

/** "a, b and c". */
function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** "Email API key" → "email API key" mid-sentence; a name that starts with a
 *  proper noun or a code ("Stripe…", "x402…") is left alone. */
function lowerFirst(noun: string): string {
	return /^(Email|Webhook)\b/.test(noun) ? noun.charAt(0).toLowerCase() + noun.slice(1) : noun;
}

/** Bump a token's save generation. Call ONLY on an actual (non-empty) persist —
 *  never on a blank submit, which already leaves the field's stated content
 *  correct (still empty), so there is nothing to force a remount for. */
async function bumpSaveGen(ctx: PluginContext, key: string): Promise<void> {
	await ctx.kv.set(key, (await readSaveGen(ctx, key)) + 1);
}

/** The action ids the admin-route dispatcher recognizes as belonging to the
 *  Settings form (so a `block_action`/`form_submit` carrying one of these — and
 *  NO `page` — is routed here, not to Reports). */
export const SETTINGS_ACTION_IDS: ReadonlySet<string> = new Set([
	"save-display",
	"save-operational",
	SAVE_BACKGROUND_WORK_ACTION,
	// INC-C3: the four payment/email secrets, from the one table that also builds
	// their forms — so a new secret is routable the moment it is declared.
	...PAYMENT_SECRET_FIELDS.map((spec) => spec.actionId),
	// INC-C5: their non-secret companions, saved as one form.
	SAVE_PAYMENT_SETTINGS_ACTION,
	// U-8: removing a stored secret on purpose.
	CLEAR_PAYMENT_SECRET_ACTION,
]);

/** The three settings fields this phase moves end-to-end (§2). */
export interface SettingsSchema {
	storeDisplayName: SettingsFieldSpec;
	holdTtlMinutes: SettingsFieldSpec;
	lowStockThreshold: SettingsFieldSpec;
}

/** `admin.settingsSchema` (§5.3) — the source-of-truth field shapes a manifest
 *  generator reads. Only kv- and service-tier fields; NO `secret` field. */
export const SETTINGS_SCHEMA: SettingsSchema = {
	storeDisplayName: {
		type: "string",
		label: "Store display name",
		description:
			"Your store's name as shown in this admin, in sign-in emails and at the end of order emails.",
		tier: "kv",
	},
	holdTtlMinutes: {
		type: "number",
		label: "Cart hold time (minutes)",
		description: "How long items in a shopper's checkout stay reserved for them.",
		tier: "service",
	},
	lowStockThreshold: {
		type: "number",
		label: "Low-stock threshold",
		description: "Products at or below this stock count show in the low-stock report.",
		tier: "service",
	},
};

const DISPLAY_NAME_MAX = 200;

export interface SettingsFormInput {
	/** em-dash BlockInteraction discriminant: `"page_load"` | `"block_action"` |
	 *  `"form_submit"`. Present on a real host interaction; absent → treated as a
	 *  page load. */
	type?: unknown;
	/** "save-display" (kv), "save-operational" (service), one of the
	 *  payment/email secret action ids (secret kv), "save-payment-settings"
	 *  (kv), or a page load. */
	action_id?: unknown;
	values?: Record<string, unknown>;
	/** A button's payload (`block_action`): the Remove button's `{ secret }`. */
	value?: unknown;
	/** Idempotency key for the privileged PUT (defaulted if absent). */
	idempotencyKey?: unknown;
}

export function createSettingsFormHandler(): RouteHandler<SettingsFormInput> {
	const renderPage = (
		ctx: PluginContext,
		client: ReportingSettingsSurface,
		notice?: Notice,
		paymentRefusal?: PaymentRefusal,
	): Promise<BlockResponse> => renderSettingsPage(ctx, client, notice, paymentRefusal);
	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		const action = typeof input.action_id === "string" ? input.action_id : "load";
		// THE COMPOSITION ROOT, not a constructor (work order 02, INC-B10c-ii):
		// this screen no longer knows which transport serves it. INC-D3a removed
		// the last reason it would have needed to: `makeAdminClients` used to take
		// a `tokens` argument read here so the http branch would not read
		// write-only kv a second time, but with the commerce service folded into
		// the plugin (ADR-0014 D3) there is no second deployable to authenticate
		// to, so there are no tokens to read or thread through at all.
		const { reporting: client } = await makeAdminClients(ctx);

		// -- kv save path: display name, S-5/S-5a ------------------------------
		if (action === "save-display") {
			const raw = input.values?.storeDisplayName;
			const name = typeof raw === "string" ? raw.trim() : "";
			if (name.length === 0 || name.length > DISPLAY_NAME_MAX) {
				// BUG FIX: this branch used to return `[header, banner]` — two
				// blocks, no form — so a merchant who typed a 201-char name was
				// stranded with no field to correct it. Re-render the full page.
				return renderPage(ctx, client, {
					variant: "error",
					title: "Display name not saved",
					description: `Store display name must be 1–${DISPLAY_NAME_MAX} characters — it was not changed.`,
				});
			}
			await ctx.kv.set(STORE_DISPLAY_NAME_KEY, name);
			// BUG FIX + S-5a: this branch used to return `[header, section]` — the
			// other three forms vanished, and because the host's `page_load`
			// effect is keyed on `[sendInteraction, page]` and never re-fires on
			// its own, that receipt was TERMINAL (the operator had to navigate
			// away to recover). Re-render the full page instead.
			//
			// S-5a ALSO retires a documented invariant DELIBERATELY, rather than
			// leaving stale prose behind: this used to say the kv save path
			// "provably never touches ctx.http" and a test asserted
			// `stub.requests` was empty. That is no longer true — there is no
			// operational-settings value already in scope here to re-render the
			// other two groups from without a live `GET /settings`, so the fresh
			// read is the fix, not a regression to hide. The test was updated in
			// the same change (see `settings-widget.sandbox.test.ts`).
			const page = await renderPage(ctx, client, {
				variant: "default",
				title: "Display name saved",
				description: `Store display name saved: ${name}.`,
			});
			return {
				...page,
				toast: { message: "Display name saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- kv save path: Background work per minute -----------------------------
		// The sweep's per-tick query budget. Validated here, at the one writer, and
		// REFUSED rather than clamped when out of bounds — a budget above the
		// platform's per-invocation cap fails every tick, one below the floor makes
		// no progress. The sweep re-validates on read, so nothing else can slip a
		// bad value past it either.
		if (action === SAVE_BACKGROUND_WORK_ACTION) {
			const checked = validateBackgroundWork(input.values?.backgroundWorkPerMinute);
			if (!checked.ok) {
				const page = await renderPage(ctx, client, {
					variant: "error",
					title: "Background work not saved",
					description: `${checked.message} Nothing was changed.`,
				});
				return {
					...page,
					toast: { message: "Background work not saved", type: "error" },
				} satisfies BlockResponse;
			}
			await ctx.kv.set(BACKGROUND_WORK_KEY, checked.value);
			const preset = BACKGROUND_WORK_PRESETS.find((entry) => entry.value === checked.value);
			const page = await renderPage(ctx, client, {
				variant: "default",
				title: "Background work saved",
				description: `Background work per minute set to ${preset?.label ?? String(checked.value)}. It applies from the next minute's sweep.`,
			});
			return {
				...page,
				toast: { message: "Background work saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- secret save path: payment/email secrets, WRITE-ONLY to ctx.kv ----------
		// INC-C3, driven off PAYMENT_SECRET_FIELDS so every secret behaves the same
		// way by construction rather than by four copies agreeing: persist ONLY on a
		// non-empty submit (a blank submit keeps what is stored), bump the save
		// generation so the mount-only field remounts blank, and NEVER put the
		// value in a block, a label, a notice or a toast. `raw` is not captured by
		// anything that survives this block.
		const secretSpec = PAYMENT_SECRET_FIELDS.find((spec) => spec.actionId === action);
		if (secretSpec !== undefined) {
			const raw = input.values?.[secretSpec.fieldId];
			// U-8: TRIMMED, so a key copied with a trailing newline is stored as the
			// key — and a whitespace-only submit is the blank submit it looks like.
			const entered = typeof raw === "string" && raw.trim() !== "";
			if (entered) {
				const checked = secretSpec.check(raw);
				if (!checked.ok) {
					// U-8: a wrong paste is REFUSED, naming the field and the shape it
					// needs — never the value — and the key already stored stays.
					const page = await renderPage(ctx, client, {
						variant: "error",
						title: `${secretSpec.noun} not saved`,
						description: `The ${lowerFirst(secretSpec.noun)} ${checked.problem}. Nothing was saved.`,
					});
					return {
						...page,
						toast: { message: `${secretSpec.noun} not saved`, type: "error" },
					} satisfies BlockResponse;
				}
				await ctx.kv.set(secretSpec.kvKey, checked.value);
				await bumpSaveGen(ctx, secretSpec.genKey);
				// A5. The INC-C3 key this credential moved OFF of holds a value with a
				// different threat model (an offline HMAC secret, never transmitted)
				// that nothing reads any more. Deleting it here — the one moment an
				// operator is demonstrably re-provisioning this credential — keeps an
				// orphaned forge-a-settlement secret from sitting in kv forever.
				// Fail-soft: a kv that cannot delete must not fail a save that already
				// succeeded.
				if (secretSpec.kvKey === X402_FACILITATOR_API_KEY_KEY) {
					try {
						await ctx.kv.delete(X402_LEGACY_FACILITATOR_SECRET_KEY);
					} catch {
						// deliberately ignored — see above
					}
				}
			}
			const page = await renderPage(ctx, client, secretNotice(secretSpec, entered));
			return {
				...page,
				toast: {
					message: `${secretSpec.noun} ${entered ? "saved" : "unchanged"}`,
					type: entered ? "success" : "info",
				},
			} satisfies BlockResponse;
		}

		// -- remove a stored secret (U-8) ---------------------------------------------
		// The button sits under a SET secret's form, behind a confirm dialog, and
		// carries only which secret (`{ secret: <fieldId> }`). Anything else — a
		// missing or unknown name — removes nothing and says so.
		if (action === CLEAR_PAYMENT_SECRET_ACTION) {
			const named =
				typeof input.value === "object" && input.value !== null && "secret" in input.value
					? (input.value as { secret: unknown }).secret
					: undefined;
			const spec = secretSpecByField(named);
			if (spec === undefined) {
				const page = await renderPage(ctx, client, {
					variant: "error",
					title: "Key not removed",
					description: "That button did not name a key on this page. Nothing was removed.",
				});
				return { ...page, toast: { message: "Key not removed", type: "error" } };
			}
			// Nothing stored: say so rather than claim a removal (a second click, or
			// a page left open while someone else removed it).
			if ((await readWriteOnlySecret(ctx, spec.kvKey)) === undefined) {
				const page = await renderPage(ctx, client, {
					variant: "default",
					title: `No ${lowerFirst(spec.noun)} was stored — nothing was removed.`,
				});
				return { ...page, toast: { message: "Nothing removed", type: "info" } };
			}
			await ctx.kv.delete(spec.kvKey);
			const page = await renderPage(ctx, client, {
				variant: "default",
				title: `${spec.noun} removed`,
				description: `${spec.removeEffect} Copy it again from ${spec.whereToFind}, then enter it above.`,
			});
			return {
				...page,
				toast: { message: `${spec.noun} removed`, type: "success" },
			} satisfies BlockResponse;
		}

		// -- kv save path: the NON-secret payment/email settings (INC-C5) -----------
		// ALL-OR-NOTHING. `payTo` is validated here, at the write end, because kv
		// validates nothing itself and this value is the buyer's payment
		// destination: a typo that is merely STORED would leave the operator with a
		// screen that says "saved" and a checkout that silently never offers x402
		// (`wireX402Gateway` fail-closes on the same predicate). Refusing the whole
		// submit — rather than persisting the two valid siblings — means the
		// operator never has to guess which half landed.
		if (action === SAVE_PAYMENT_SETTINGS_ACTION) {
			// ABSENT IS NOT EMPTY (review round 2, B3). A submit that carries no entry
			// at all for a field is not an instruction to CLEAR that field — the host
			// omits values for reasons that have nothing to do with intent (a field
			// the operator never focused, a partial dispatch, a future block that
			// stops echoing untouched inputs). Coercing absence to `""` and writing it
			// unconditionally would silently blank `settings:x402PayTo`, which
			// fail-closes x402 across the whole deployment with a screen that says
			// "saved". A PRESENT empty string is still honoured: that is an operator
			// who cleared the box on purpose.
			const submitted = new Map(
				PLAIN_PAYMENT_SETTINGS.flatMap((spec) => {
					const raw = input.values?.[spec.fieldId];
					return typeof raw === "string" ? [[spec.kvKey, raw.trim()] as const] : [];
				}),
			);
			// Review nit: EVERY broken rule is collected, so the operator fixes them
			// in one pass. Each names the FIELD and the SHAPE, never the rejected
			// value (the form, not the banner, keeps what was typed).
			const problems: Array<{ field: string; rule: string }> = [];
			const payTo = submitted.get(X402_PAYTO_KEY) ?? "";
			if (payTo.length > 0 && !isPlausiblePayTo(payTo)) {
				problems.push({
					field: "the x402 destination wallet",
					rule: "The x402 destination wallet is not a wallet address (expected 0x followed by 40 hex characters, optionally CAIP-10 prefixed).",
				});
			}
			// Issue #306: the sign-in link page must be an absolute URL with no
			// credentials — the emailed token rides on it. U-8: and https, or http
			// only on this machine, so that token never crosses a network in clear
			// text (`isSavableLoginLinkUrl`).
			const loginLinkUrl = submitted.get(LOGIN_LINK_URL_KEY) ?? "";
			if (loginLinkUrl.length > 0 && !isSavableLoginLinkUrl(loginLinkUrl)) {
				problems.push({
					field: "the sign-in page address",
					rule: "The sign-in page address must be a full https:// address (http:// only for localhost) with no username or password.",
				});
			}
			// The from-address must be one a real provider will send from: a bare
			// `addr@domain` or `Name <addr@domain>`, on a domain that is not a
			// reserved name (`.local`, `.test`, `example.com`, …). EMPTY stays
			// allowed — clearing the box falls back to the dev default, which a local
			// mail catcher accepts.
			const emailFrom = submitted.get(EMAIL_FROM_KEY) ?? "";
			if (emailFrom.length > 0 && !isDeliverableFromAddress(emailFrom)) {
				problems.push({
					field: "the order email from-address",
					rule: "The order email from-address must be name@domain or Name <name@domain> on a real domain (not .local, .test or example.com; write an international domain in its xn-- form).",
				});
			}
			if (problems.length > 0) {
				// One problem: its rule IS the banner. Several: the banner names them
				// all (the 240-character budget cannot hold every rule) and each rule
				// is stated in full beside the form.
				const [only] = problems;
				const description =
					problems.length === 1 && only !== undefined
						? `${only.rule} Nothing was saved.`
						: `${String(problems.length)} settings need fixing: ${joinNames(problems.map((p) => p.field))}. Each rule is stated above the form. Nothing was saved.`;
				const typed = new Map(
					PLAIN_PAYMENT_SETTINGS.flatMap((spec) => {
						const raw = input.values?.[spec.fieldId];
						if (typeof raw !== "string") return [];
						// A sign-in URL with user:pw@ in it is put back WITHOUT them: the
						// credentials are refused anyway, and are not echoed into the page.
						const shown = spec.kvKey === LOGIN_LINK_URL_KEY ? withoutUserInfo(raw) : raw;
						return [[spec.kvKey, shown] as const];
					}),
				);
				return renderPage(
					ctx,
					client,
					{ variant: "error", title: "Payment settings not saved", description },
					{ problems: problems.map((p) => p.rule), typed },
				);
			}
			for (const [key, value] of submitted) await ctx.kv.set(key, value);
			const page = await renderPage(ctx, client, {
				variant: "default",
				title: "Payment settings saved",
				description: "The from-address, sign-in page and x402 settings were saved.",
			});
			return {
				...page,
				toast: { message: "Payment settings saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- operational settings: hold time and low-stock threshold --------------------
		// U-8: ALL-OR-NOTHING, like the payment settings. Every present value is
		// checked here first — a value that is not a whole number in range is
		// REFUSED by the field's name, and nothing in the submit is saved. It used
		// to be dropped from the patch instead, so "abc" or "-1" saved nothing and
		// the screen still said "Settings saved".
		if (action === "save-operational") {
			const checked = checkOperationalValues(input.values ?? {});
			// This branch writes no display name, so a fresh read here is current.
			const state = await readPageState(ctx);
			const refuse = async (title: string, description: string): Promise<BlockResponse> => {
				let stored: OperationalSettingsWire | undefined;
				try {
					stored = await client.getSettings();
				} catch {
					stored = undefined;
				}
				return {
					blocks: buildSettingsBlocks({
						...state,
						// J6: the form keeps what was typed — exactly as typed, so "abc"
						// can be corrected — over the stored value for an untouched field.
						settings: {
							holdTtlMinutes: checked.typed.holdTtlMinutes ?? String(stored?.holdTtlMinutes ?? ""),
							lowStockThreshold:
								checked.typed.lowStockThreshold ?? String(stored?.lowStockThreshold ?? ""),
						},
						// INC-15: the LABEL reads as persisted state, so on a refusal it
						// keeps stating what is stored ("not loaded" when that re-read
						// failed), never the refused value.
						persisted: stored,
						notice: { variant: "error", title, description },
					}),
					toast: { message: title, type: "error" },
				};
			};
			if (checked.problems.length > 0) {
				return refuse("Settings not saved", `${checked.problems.join(" ")} Nothing was saved.`);
			}
			const key =
				typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
					? input.idempotencyKey
					: `settings-${Date.now()}`;
			// There is nothing to authenticate any more (INC-D3a): `updateSettings`
			// runs in-process against this plugin's own store, not a separate
			// service call that would need a token attached.
			const result = await client.updateSettings(checked.patch, { idempotencyKey: key });
			if (!result.ok) {
				// WHY THE SAVE FAILED, from the STRUCTURAL field first. `reason` is
				// stated by every tier that can say why; `status` is the HTTP tier's
				// legacy fallback and is read ONLY when `reason` is absent, because the
				// in-process tier refuses to synthesize an HTTP status it does not have
				// (INC-B10a). A lost compare-and-set is the one outcome worth its own
				// words: re-submitting the same patch under the same key cannot win it,
				// so the banner says reload rather than "try again".
				const superseded =
					result.reason === "superseded" || (result.reason === undefined && result.status === 409);
				// The domain checks the same bounds as `checkOperationalValues`, so a
				// refusal here is a backstop — still worded with the field's name, not
				// the domain's identifier.
				return superseded
					? refuse("Settings changed by someone else", `${result.message} Nothing was saved.`)
					: refuse("Settings not saved", `${namedForOperator(result.message)} Nothing was saved.`);
			}
			return {
				blocks: buildSettingsBlocks({
					...state,
					settings: formValuesOf(result.settings),
					// An ACCEPTED save: what is shown and what is stored are the same
					// thing, so the label states the values that just persisted.
					persisted: result.settings,
					notice: {
						variant: "default",
						title: "Settings saved",
						description: savedOperationalSentence(result.settings),
					},
				}),
				toast: { message: "Settings saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- page load: render current values (kv + GET /settings) ------------------
		return renderPage(ctx, client);
	};
}

/**
 * Render the full Settings page from kv + the client's `getSettings()` read
 * (in-process since INC-D3a; the surface is the same one ADR-0010 guarded when
 * it was an HTTP `GET /settings`). Always the FULL three-accordion screen
 * (S-5): the caller supplies an optional `notice` for the top banner (an
 * action's outcome); a bare page load passes none.
 *
 * E-1 / director ruling: `getSettings()` feeds ONLY the "Checkout & holds"
 * group — a SECONDARY read on a screen with no single primary collection (§4.1
 * has no list/detail "primary data block" concept to fail closed on). Its
 * failure therefore degrades to a `context` line inside that one group,
 * never a screen-wide fail-closed banner: the display name and the payment
 * secret forms need no settings read at all, and must keep working (no bootstrap
 * lockout). An earlier draft rendered a top-level `error` banner here, which
 * §12.6's listing implied — that is the N-1 defect this fixes; E-1's
 * primary/secondary split is the rule, and it wins.
 */
async function renderSettingsPage(
	ctx: PluginContext,
	client: ReportingSettingsSurface,
	notice?: Notice,
	paymentRefusal?: PaymentRefusal,
): Promise<BlockResponse> {
	const state = await readPageState(ctx);
	try {
		// Nothing was attempted on this path, so what the form shows and what the
		// label states are the same read (see `persisted` in `buildSettingsBlocks`).
		const settings = await client.getSettings();
		return {
			blocks: buildSettingsBlocks({
				...state,
				settings: formValuesOf(settings),
				persisted: settings,
				notice,
				paymentRefusal,
			}),
		};
	} catch {
		return {
			blocks: buildSettingsBlocks({
				...state,
				settings: undefined,
				persisted: undefined,
				notice,
				paymentRefusal,
			}),
		};
	}
}

/** What the "Checkout & holds" form shows: strings, because on a refused save
 *  it shows exactly what was typed (J6), and "abc" is not a number. */
interface OperationalFormValues {
	holdTtlMinutes: string;
	lowStockThreshold: string;
}

function formValuesOf(settings: OperationalSettingsWire): OperationalFormValues {
	return {
		holdTtlMinutes: String(settings.holdTtlMinutes),
		lowStockThreshold: String(settings.lowStockThreshold),
	};
}

/** Non-money integer fields (minutes, thresholds) route through `text_input`
 *  with ONE parsing discipline (F-6): digits only, no sign, no decimal point.
 *  Accepts a raw `number` too — defensive only, since the real host's
 *  `text_input` always submits a string. */
const DIGITS_ONLY = /^\d+$/;

/** Each operational field: its name as the operator reads it, its bounds, and
 *  the rule a refusal states. The bounds are the domain's own
 *  (`MAX_HOLD_TTL_MINUTES`) and the settings client's (`MAX_LOW_STOCK_THRESHOLD`),
 *  checked here so the refusal can name the field and cover every field at once. */
const OPERATIONAL_FIELDS = [
	{
		id: "holdTtlMinutes",
		name: "Cart hold time",
		min: 1,
		max: MAX_HOLD_TTL_MINUTES,
		rule: `must be a whole number of minutes from 1 to ${String(MAX_HOLD_TTL_MINUTES)}.`,
	},
	{
		id: "lowStockThreshold",
		name: "Low-stock threshold",
		min: 0,
		max: MAX_LOW_STOCK_THRESHOLD,
		rule: `must be a whole number from 0 to ${String(MAX_LOW_STOCK_THRESHOLD)}.`,
	},
] as const satisfies ReadonlyArray<{
	id: keyof OperationalSettingsWire;
	name: string;
	min: number;
	max: number;
	rule: string;
}>;

/**
 * U-8: check every PRESENT operational value. A field absent from the submit is
 * left alone (absent is not empty — the INC-C5 rule); a field present but blank,
 * signed, fractional, non-numeric or out of range is a PROBLEM, named. The patch
 * is only meant to be sent when there are no problems.
 */
function checkOperationalValues(values: Record<string, unknown>): {
	patch: Partial<OperationalSettingsWire>;
	typed: Partial<OperationalFormValues>;
	problems: string[];
} {
	const patch: Partial<OperationalSettingsWire> = {};
	const typed: Partial<OperationalFormValues> = {};
	const problems: string[] = [];
	for (const spec of OPERATIONAL_FIELDS) {
		const raw = values[spec.id];
		if (typeof raw !== "string" && typeof raw !== "number") continue;
		const text = String(raw).trim();
		typed[spec.id] = typeof raw === "string" ? raw : text;
		const value = DIGITS_ONLY.test(text) ? Number(text) : Number.NaN;
		if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
			problems.push(`${spec.name} ${spec.rule}`);
			continue;
		}
		patch[spec.id] = value;
	}
	return { patch, typed, problems };
}

/** A settings-store message names fields by identifier ("holdTtlMinutes must
 *  be…"); the operator knows them by their labels. */
function namedForOperator(message: string): string {
	let named = message;
	for (const spec of OPERATIONAL_FIELDS) named = named.replaceAll(spec.id, spec.name);
	return /[.!?]$/.test(named) ? named : `${named}.`;
}

/** The receipt for an accepted save: what is now in force, in words. */
function savedOperationalSentence(settings: OperationalSettingsWire): string {
	const minutes = settings.holdTtlMinutes === 1 ? "minute" : "minutes";
	return `Cart hold time is ${String(settings.holdTtlMinutes)} ${minutes} and the low-stock threshold is ${String(settings.lowStockThreshold)}.`;
}

/**
 * §4.1 / §12.6 skeleton: header, page context, an optional notice banner, then
 * exactly three named groups — "Store", "Checkout & holds", "Payments &
 * email" — each an `accordion`. (INC-D3a retired a fourth, "Service
 * connection", along with the two tokens it existed to provision — see the
 * module doc comment.)
 *
 * INC-15 amends S-3 for THIS screen: all three groups now render
 * `default_open: false`, and each group's LABEL carries its own current values
 * ("Checkout & holds — 15 min hold · low stock at 5"), so a closed group still
 * answers the question the operator opened the screen to ask. The screen used
 * to open "Store" — the ONE cosmetic field on it — pushing the two groups that
 * hold operational and payment state below an expanded form. With the values
 * on the labels there is nothing to rank: S-3's "exactly one" was a way to pick
 * a default, not a requirement that something be expanded, and the mechanical
 * rule (X-18) is "AT MOST one `default_open: true` per response". Zero is legal
 * and is what this screen now emits.
 *
 * This is the RENDER-TIME kind of closing, which §1.2 explicitly permits — no
 * `block_id` is changed to force a group shut, so no operator input is ever
 * discarded (that is the forbidden "programmatic accordion close").
 *
 * S-4: every prefilling form's `block_id` comes from `carriedForm` so a saved
 * value redisplays correctly (the forms are mount-only `text_input` and, for
 * the keys, `secret_input` — and once inside an accordion each is that
 * container's own index-0 child forever — nothing else remounts them).
 */
function buildSettingsBlocks(args: {
	displayName: string;
	/** What the "Checkout & holds" FORM prefills from — on a rejected save this
	 *  carries the ATTEMPTED values over the stored ones (J6), so the operator can
	 *  correct what they typed. */
	settings: OperationalFormValues | undefined;
	/** What the "Checkout & holds" LABEL states: only values the service actually
	 *  holds, `undefined` when that is unknown. A collapsed label reads as
	 *  persisted state — it is the one thing on this screen that does — so it must
	 *  never state a value that was rejected. */
	persisted: OperationalSettingsWire | undefined;
	paymentSecrets: Map<string, SecretRenderState>;
	plainSettings: Map<string, string>;
	backgroundWork: number;
	notice?: Notice;
	paymentRefusal?: PaymentRefusal;
}): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Settings" },
		{
			type: "context",
			text: "Your store's name, how checkout holds stock, and the payment and email accounts the store uses.",
		},
	];
	if (args.notice !== undefined) blocks.push(noticeBanner(args.notice));
	blocks.push(
		storeGroup(args.displayName),
		checkoutGroup(args.settings, args.persisted, args.backgroundWork),
		paymentsGroup(args.paymentSecrets, args.plainSettings, args.paymentRefusal),
	);
	return blocks;
}

/** §1's accordion-label budget (X-11). */
const LABEL_BUDGET = 60;

/** Separator between the values on a D-6 label. */
const VALUE_SEPARATOR = " · ";

function fitLabel(text: string): string {
	return text.length <= LABEL_BUDGET ? text : `${text.slice(0, LABEL_BUDGET - 1)}…`;
}

/**
 * A D-6 `<group> — <value> · <value>` label, kept inside the X-11 budget by
 * shortening a VALUE rather than the tail. EVERY label on this screen goes
 * through here, the constant ones included — a bypass is how one of them drifts
 * over budget unnoticed.
 *
 * Right-truncation would eat the LAST value outright: a 200-character display
 * name is the one operator-supplied value on this screen with no length bound
 * of its own, and on a two-value label the tail is the value most worth
 * keeping. So the truncation costs the LONGEST segment, and only by the
 * overflow. (Same helper, same reasoning, as `products-page.ts`'s — this file
 * keeps its own copy the way it keeps its own `fitLabel`, rather than growing
 * the shared scaffold for a label rule two screens use differently.)
 */
function valueLabel(prefix: string, values: readonly string[]): string {
	if (values.length === 0) return fitLabel(prefix);
	const full = `${prefix} — ${values.join(VALUE_SEPARATOR)}`;
	if (full.length <= LABEL_BUDGET) return full;
	let longest = 0;
	values.forEach((value, index) => {
		if (value.length > (values[longest] ?? "").length) longest = index;
	});
	const room = (values[longest] ?? "").length - (full.length - LABEL_BUDGET) - 1;
	if (room < 1) return fitLabel(full);
	const shortened = values.map((value, index) =>
		index === longest ? `${value.slice(0, room)}…` : value,
	);
	return `${prefix} — ${shortened.join(VALUE_SEPARATOR)}`;
}

/** The Store group's label carries the name itself, so the one thing this group
 *  holds is readable closed. An unset name says so — never a blank tail after
 *  the dash, which would read as a rendering fault rather than as "not set". */
function storeGroupLabel(displayName: string): string {
	return valueLabel("Store", [displayName.length > 0 ? displayName : "no display name"]);
}

/** The PERSISTED operational values, closed: "Checkout & holds — 15 min hold ·
 *  low stock at 5". When the secondary `GET /settings` read failed — or a
 *  rejected save left nothing stored to state — there is no value to give, and
 *  the label says exactly that rather than implying a zero (the group's own body
 *  carries the full E-1 explanation). */
function checkoutGroupLabel(persisted: OperationalSettingsWire | undefined): string {
	if (persisted === undefined) return valueLabel("Checkout & holds", ["not loaded"]);
	return valueLabel("Checkout & holds", [
		`${persisted.holdTtlMinutes} min hold`,
		`low stock at ${persisted.lowStockThreshold}`,
	]);
}

function storeGroup(displayName: string): AccordionBlock {
	return {
		type: "accordion",
		block_id: "settings:store",
		label: storeGroupLabel(displayName),
		default_open: false, // INC-15: the label carries the value; see buildSettingsBlocks
		blocks: [
			carriedForm({
				namespace: "settings:store",
				form: {
					type: "form",
					fields: [
						{
							type: "text_input",
							action_id: "storeDisplayName",
							label: SETTINGS_SCHEMA.storeDisplayName.label,
							initial_value: displayName,
						},
					],
					submit: { label: "Save display name", action_id: "save-display" },
				},
			}),
		],
	};
}

/** What the choice means, in the operator's terms. */
const backgroundWorkContext: Block = {
	type: "context",
	text: "Background work: how much the every-minute sweep (hold expiry, order emails) may do. Free allows 50 database queries a run, Paid 1000 — stores with sale spikes should be on Paid.",
};

/**
 * "Background work per minute" — a radio of the two plan presets, beside the
 * hold TTL because it decides how fast expired holds come back on sale.
 *
 * A `radio`, because a Block Kit `select` shows the raw value, not the label
 * (R-17a). A stored value that is not a preset (one saved before
 * the presets changed, say) is offered as its own "Custom" row, so the form
 * never shows a choice that is not what is stored. Keyed on its prefill by
 * `carriedForm`, so a new stored value remounts it.
 */
function backgroundWorkForm(backgroundWork: number): FormBlock {
	const presets = BACKGROUND_WORK_PRESETS.map((preset) => ({
		value: String(preset.value),
		label: preset.label,
	}));
	const options = BACKGROUND_WORK_PRESETS.some((preset) => preset.value === backgroundWork)
		? presets
		: [...presets, { value: String(backgroundWork), label: `Custom (${String(backgroundWork)})` }];
	return carriedForm({
		namespace: "settings:background-work",
		form: {
			type: "form",
			fields: [
				{
					type: "radio",
					action_id: "backgroundWorkPerMinute",
					label: "Background work per minute",
					options,
					initial_value: String(backgroundWork),
				},
			],
			submit: { label: "Save background work", action_id: SAVE_BACKGROUND_WORK_ACTION },
		},
	});
}

function checkoutGroup(
	settings: OperationalFormValues | undefined,
	persisted: OperationalSettingsWire | undefined,
	backgroundWork: number,
): AccordionBlock {
	const body: Block[] =
		settings === undefined
			? [
					// E-1 secondary-read failure: a context line, never a banner, and
					// never a fail-closed whole screen (see `renderPage`'s doc comment).
					{
						type: "context",
						text: "Checkout settings could not be loaded right now. Reload to try again — the rest of this page still works.",
					},
					// Stored in plugin kv, not the settings store, so it stays usable.
					backgroundWorkContext,
					backgroundWorkForm(backgroundWork),
				]
			: [
					{
						type: "context",
						text: "These apply to live checkout as soon as you save them.",
					},
					carriedForm({
						namespace: "settings:ops",
						form: {
							type: "form",
							fields: [
								{
									type: "text_input",
									action_id: "holdTtlMinutes",
									label: SETTINGS_SCHEMA.holdTtlMinutes.label,
									initial_value: settings.holdTtlMinutes,
								},
								{
									type: "text_input",
									action_id: "lowStockThreshold",
									label: SETTINGS_SCHEMA.lowStockThreshold.label,
									initial_value: settings.lowStockThreshold,
								},
							],
							submit: { label: "Save checkout settings", action_id: "save-operational" },
						},
					}),
					backgroundWorkContext,
					backgroundWorkForm(backgroundWork),
				];
	return {
		type: "accordion",
		block_id: "settings:checkout",
		label: checkoutGroupLabel(persisted),
		default_open: false,
		blocks: body,
	};
}

/**
 * INC-C3 — the "Payments & email" group: the provisioning surface for the four
 * credentials that used to be `wrangler secret put` entries on the standalone
 * `@otta-sh/service` package's own wrangler config. With the service folded in
 * there is no second deployable to hold them, so this screen is where they land.
 *
 * U-8: every key field is an ALWAYS-EMPTY `secret_input` — a password box, so a
 * live key being typed or pasted is not on screen for anyone behind the
 * operator. Still no `initial_value` (nothing stored is ever sent to the
 * browser) and no `has_value` (that makes the host draw a fake "••••••••"
 * value that reveals to the same dots, the confusion INC-09 removed). Whether a
 * key is set is stated in its LABEL instead, and a set key gets a Remove button.
 */
function paymentsGroup(
	state: Map<string, SecretRenderState>,
	plain: Map<string, string>,
	refusal?: PaymentRefusal,
): AccordionBlock {
	return {
		type: "accordion",
		block_id: "settings:payments",
		label: paymentsGroupLabel(state),
		default_open: false,
		blocks: [
			{
				type: "context",
				text: "Keys are never shown once saved. Leave a field blank to keep the key you saved before.",
			},
			...PAYMENT_SECRET_FIELDS.flatMap((spec) => {
				const secret = state.get(spec.kvKey);
				const help: Block = { type: "context", text: spec.shapeHelp };
				const form = secretForm(spec, secret?.set === true, secret?.gen ?? 0);
				return secret?.set === true ? [help, form, removeSecretActions(spec)] : [help, form];
			}),
			// INC-C5: the non-secret companions, LAST so the group still reads
			// keys-first, and visibly a different kind of field — these prefill with
			// what is stored.
			{
				type: "context",
				text: "The settings below are shown as saved. x402 payments are not available yet. These settings are kept for when they are.",
			},
			...legacySignInWarning(plain.get(LOGIN_LINK_URL_KEY) ?? ""),
			// A refused save states each rule in full beside the form, and the form
			// keeps what was typed (J6).
			...(refusal?.problems ?? []).map((problem): Block => ({ type: "context", text: problem })),
			plainSettingsForm(refusal === undefined ? plain : new Map([...plain, ...refusal.typed])),
		],
	};
}

/** A refused payment-settings save: every rule broken, and what was typed. */
interface PaymentRefusal {
	problems: string[];
	typed: Map<string, string>;
}

/** Review nit: a STORED sign-in page that is valid but clear text off this
 *  machine was saved before the https rule. It is still used (the send path
 *  keeps `isValidLoginLinkUrl`), so the screen says so rather than blocking it. */
function legacySignInWarning(stored: string): Block[] {
	if (stored === "" || !isValidLoginLinkUrl(stored) || isSavableLoginLinkUrl(stored)) return [];
	return [
		{
			type: "banner",
			variant: "alert",
			title: "Sign-in page address needs https",
			description:
				"The links in sign-in emails point to an http page, so their tokens travel unencrypted when clicked — change this address to https. You'll need to change it before saving other payment settings.",
		},
	];
}

/** The three non-secret payment/email settings, as ONE form. Prefilled from kv —
 *  the visible difference from the write-only fields above it, and the whole
 *  reason they are a separate form rather than five more entries in
 *  {@link PAYMENT_SECRET_FIELDS}. */
function plainSettingsForm(plain: Map<string, string>): FormBlock {
	return carriedForm({
		namespace: `settings:${SAVE_PAYMENT_SETTINGS_ACTION}`,
		form: {
			type: "form",
			fields: PLAIN_PAYMENT_SETTINGS.map((spec) => ({
				type: "text_input" as const,
				action_id: spec.fieldId,
				label: spec.label,
				placeholder: spec.placeholder,
				initial_value: plain.get(spec.kvKey) ?? "",
			})),
			submit: { label: "Save payment settings", action_id: SAVE_PAYMENT_SETTINGS_ACTION },
		},
	});
}

/** U-8 — what card checkout and email have, readable with the group closed:
 *  "Payments & email — Stripe test · webhook set · email set".
 *
 *  The old label listed whichever of the five keys were missing, so a store with
 *  working card checkout and email read "no x402, edge" — two optional keys —
 *  as if something were broken. It now states the three that decide whether
 *  the store can take a card payment and send an email. The x402 and edge keys
 *  state their own status on their fields.
 *
 *  SECURITY: "set" and the Stripe mode (from the key's prefix) are FACTS ABOUT a
 *  key, not any part of it; no value is in scope here. The longest render
 *  ("no Stripe key"/"Stripe key set" · "webhook set" · "email set") is exactly
 *  the X-11 60-character budget. */
function paymentsGroupLabel(state: Map<string, SecretRenderState>): string {
	const stripe = state.get(STRIPE_SECRET_KEY_KEY);
	const stripePart =
		stripe?.set !== true
			? "no Stripe key"
			: stripe.mode === undefined
				? "Stripe key set"
				: `Stripe ${stripe.mode}`;
	const webhookPart =
		state.get(STRIPE_WEBHOOK_SECRET_KEY)?.set === true ? "webhook set" : "no webhook";
	const emailPart = state.get(EMAIL_API_KEY_KEY)?.set === true ? "email set" : "no email";
	return valueLabel("Payments & email", [stripePart, webhookPart, emailPart]);
}

/** One write-only secret field, with a `gen`-carried post-save clear: because
 *  the field never varies, `carriedForm`'s own prefill digest is constant, so
 *  the save generation rides in the carrier CONTEXT to change the form's
 *  `block_id` on a real save and force the mount-only input to remount
 *  blank. The label's "— set" / "— not set" is a prop, not a prefill: it
 *  updates without a remount. */
function secretForm(spec: SecretFieldSpec, set: boolean, gen: number): FormBlock {
	return carriedForm({
		namespace: `settings:${spec.actionId}`,
		context: { gen: String(gen) },
		form: {
			type: "form",
			fields: [
				{
					type: "secret_input",
					action_id: spec.fieldId,
					label: `${spec.label} — ${set ? "set" : "not set"}`,
					placeholder: set ? "Set — leave blank to keep it, or enter a new one" : spec.hint,
				},
			],
			submit: { label: `Save ${lowerFirst(spec.noun)}`, action_id: spec.actionId },
		},
	});
}

/** U-8 — the Remove button under a SET key, behind a confirm that says what
 *  stops working. */
function removeSecretActions(spec: SecretFieldSpec): Block {
	return {
		type: "actions",
		elements: [
			{
				type: "button",
				action_id: CLEAR_PAYMENT_SECRET_ACTION,
				label: `Remove ${lowerFirst(spec.noun)}`,
				style: "danger",
				value: { secret: spec.fieldId },
				confirm: {
					title: `Remove the ${lowerFirst(spec.noun)}?`,
					text: spec.removeEffect,
					confirm: "Yes, remove it",
					deny: "Keep it",
					style: "danger",
				},
			},
		],
	};
}
