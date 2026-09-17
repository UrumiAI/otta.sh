import { EMAIL_FROM_KEY } from "../email/ctx-http-email-sender.js";
import { SERVICE_TOKEN_KEY } from "../manifest.js";
import { isPlausiblePayTo, X402_ACCEPTS_KEY, X402_PAYTO_KEY } from "../payments/x402-wiring.js";
import {
	EMAIL_API_KEY_KEY,
	readWriteOnlySecret,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
	X402_FACILITATOR_SECRET_KEY,
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
import { makeAdminClients } from "./make-admin-clients.js";
import type { OperationalSettingsWire, ReportingSettingsSurface } from "./reporting-client.js";
import {
	type AdminTokens,
	carriedForm,
	noticeBanner,
	readAdminTokens,
	type Notice,
} from "./scaffold/index.js";

/**
 * The admin Settings screen (§4.1 report/settings skeleton;
 * `docs/admin/ADMIN-CONSOLE.md` §12.6) — ONE page, THREE named groups, FOUR
 * save paths made visible, not hidden:
 *  - `storeDisplayName` (kv tier, "Store" group) saves via `ctx.kv.set`.
 *  - `holdTtlMinutes` / `lowStockThreshold` (service tier, "Checkout & holds"
 *    group) save via `PUT /settings` over `ctx.http`, surfacing the service's
 *    `400` validation error INLINE (never swallowed).
 *  - `internalToken` (secret tier, "Service connection" group) — the admin
 *    token the guarded `/reports/*` reads and the privileged `PUT /settings`
 *    need. Persisted WRITE-ONLY to `ctx.kv` under `settings:internalToken`
 *    (the em-dash webhook-notifier `secret_input` pattern) and NEVER rendered
 *    back into a block.
 *  - `serviceToken` (secret tier, "Service connection" group, ADR-0007) — the
 *    machine write-gate token the service enforces as `X-Service-Token` on
 *    every non-GET. Persisted WRITE-ONLY to `ctx.kv` under
 *    `settings:serviceToken`, same discipline as the admin token; read at
 *    runtime by every plugin client (storefront + admin) via
 *    `serviceTokenFromKv`. This is the provisioning surface deploy ordering
 *    depends on (provision here BEFORE flipping the service secret).
 *
 * SECURITY (§5): the display name is cosmetic. The admin token AND the service
 * token are shared secrets that live in em-dash's plugin-settings kv (bounded by
 * em-dash admin/DB security, the same trade-off webhook-notifier accepts). Both
 * are treated write-only (only overwritten on a non-empty submit) and have no
 * read-back path into any block, toast, or error text — but NEITHER is masked
 * (INC-09, `EVIDENCE §4.3` / `DESIGNER §7` shot `18b`): the `secret_input`
 * variant's reveal/copy chip computed to `opacity: 0` and, on hover, overlapped
 * this screen's own field label, and a revealed SET token became visually
 * identical to the unset field below it — a false affordance offering to
 * reveal something this screen's own helper text says is never displayed. Both
 * tokens now render as a plain, always-empty `text_input`. NOTE the service
 * token is MORE sensitive than the admin token — it unlocks the entire write
 * surface, not just `/admin` + `/internal`.
 *
 * S-5 / S-4: every save re-renders the FULL screen (all three accordions) plus
 * a notice banner — never a fragment. Two live bugs this fixes (§12.6):
 * `save-display`'s success path used to return `[header, section]` (the other
 * three forms vanished, and since the host's `page_load` effect never re-fires
 * on its own, the operator had to navigate away to recover — the receipt was
 * terminal), and the invalid-name branch used to return `[header, banner]`
 * with no field to correct. Both branches now go through {@link renderPage}.
 */
export const SETTINGS_PAGE: AdminPageConfig = {
	path: "/settings",
	label: "Settings",
	icon: "settings",
};

/** The kv key for the cosmetic store display name (`settings:*` = the em-dash
 *  convention for user-configurable prefs shown in admin UI). */
export const STORE_DISPLAY_NAME_KEY = "settings:storeDisplayName";

/** The kv key for the write-only admin token forwarded as `X-Internal-Token` to
 *  the guarded reporting reads + privileged settings PUT. NEVER rendered. */
export const INTERNAL_TOKEN_KEY = "settings:internalToken";

/** kv keys for each token's SAVE GENERATION (INC-09 post-save clear). Bumped by
 *  {@link bumpSaveGen} on every successful (non-empty) submit and folded into
 *  that token's own form via {@link tokenForm}/{@link serviceTokenForm}, so a
 *  save changes the form's carrier `block_id` — otherwise the mount-only
 *  `text_input` would keep showing whatever the operator just typed after a
 *  "saved" re-render, since the field itself carries no `initial_value`/
 *  `has_value` left to hang a digest off of (see `carrier.ts`'s
 *  `prefillDigest`). Independent per token: saving one must not blank the
 *  other's untouched field. */
const INTERNAL_TOKEN_GEN_KEY = "settings:internalTokenGen";
const SERVICE_TOKEN_GEN_KEY = "settings:serviceTokenGen";

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
 * Every `kvKey` is the in-process equivalent of a `@otta-sh/service` environment
 * variable (see `payment-secrets.ts` for the env-var → kv-key table and the
 * source lines). `genKey` is this secret's own save generation, independent per
 * secret so saving one never blanks another's untouched field — the same
 * reasoning as the two connection tokens above.
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
	/** Field label — names the credential, never any part of its value. */
	label: string;
	/** What the notice/toast calls it. */
	noun: string;
	/** Two words for the collapsed group label ("stripe key", "webhook"). */
	short: string;
}

const PAYMENT_SECRET_FIELDS: readonly SecretFieldSpec[] = [
	{
		actionId: "save-stripe-secret-key",
		fieldId: "stripeSecretKey",
		kvKey: STRIPE_SECRET_KEY_KEY,
		genKey: "settings:stripeSecretKeyGen",
		label: "Stripe secret key",
		noun: "Stripe secret key",
		short: "stripe key",
	},
	{
		actionId: "save-stripe-webhook-secret",
		fieldId: "stripeWebhookSecret",
		kvKey: STRIPE_WEBHOOK_SECRET_KEY,
		genKey: "settings:stripeWebhookSecretGen",
		label: "Stripe webhook signing secret",
		noun: "Stripe webhook secret",
		short: "webhook",
	},
	{
		actionId: "save-email-api-key",
		fieldId: "emailApiKey",
		kvKey: EMAIL_API_KEY_KEY,
		genKey: "settings:emailApiKeyGen",
		label: "Email provider API key",
		noun: "Email API key",
		short: "email",
	},
	{
		actionId: "save-x402-facilitator-secret",
		fieldId: "x402FacilitatorSecret",
		kvKey: X402_FACILITATOR_SECRET_KEY,
		genKey: "settings:x402FacilitatorSecretGen",
		// INC-C5 renamed what this FIELD SAYS, not the key it writes. In-process
		// the value is the bearer credential the facilitator call sends, not the
		// offline HMAC secret INC-C3's label described — an operator provisioning
		// from the old label would be handing a forge-a-settlement secret to a
		// third-party host. `short` is unchanged, so the group label stays exactly
		// inside the X-11 budget.
		label: "x402 facilitator API key",
		noun: "x402 facilitator API key",
		short: "x402",
	},
	{
		// INC-C1b. Not a renamed service env var like the four above — it is the
		// shared edge token the site attaches (`X-Otta-Wh-Token`) to a Stripe
		// webhook it forwards to the plugin's `webhooks/stripe/settle` route. It
		// gets the identical write-only treatment because it is a shared secret,
		// and it is provisioned HERE because this is the only screen an operator
		// has. Leaving it unset is a supported configuration (the route falls back
		// to Stripe-HMAC-only), which is why the group label calls it optional.
		actionId: "save-webhook-edge-token",
		fieldId: "webhookEdgeToken",
		kvKey: WEBHOOK_EDGE_TOKEN_KEY,
		genKey: "settings:otta-wh-tokenGen",
		label: "Stripe webhook edge token (optional)",
		noun: "Webhook edge token",
		// "edge", not "wh token": a fifth entry pushes the all-missing group label
		// ("Payments & email — no stripe key, webhook, email, x402, …") against
		// X-11's 60-character budget, and overflowing it makes `valueLabel` elide
		// the list — so the fresh-install label, the one case where every name
		// matters, would be the one that loses a name. Four characters keep it
		// exactly inside the budget with nothing truncated.
		short: "edge",
	},
];

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
		placeholder: "no-reply@otta.local",
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
		label: "x402 accepted networks (comma-separated CAIP-2)",
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
			return [spec.kvKey, { set: value !== undefined, gen }] as const;
		}),
	);
	return new Map(entries);
}

/** Everything this screen renders that comes out of `ctx.kv` — read ONCE per
 *  handler invocation (INC-15). */
interface SettingsPageState {
	displayName: string;
	hasToken: boolean;
	hasServiceToken: boolean;
	tokenGen: number;
	serviceTokenGen: number;
	/** INC-C3: per payment secret, "is it set" + its save generation, keyed by kv
	 *  key. NEVER the values — see {@link readPaymentSecretState}. */
	paymentSecrets: Map<string, SecretRenderState>;
	/** INC-C5: the NON-secret payment/email settings, keyed by kv key. These ARE
	 *  the values, and they are rendered back — that is the tier difference. */
	plainSettings: Map<string, string>;
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
 * The kv half of a render, from the tokens the handler ALREADY read.
 *
 * INC-15 (review note on INC-09): a render used to issue 7 kv gets one after
 * another, two of them re-reads of a token `readAdminTokens` had just fetched
 * at the top of the handler — `settings:internalToken` for `hasToken` and
 * `settings:serviceToken` for `hasServiceToken`. Both booleans are derivable
 * from the tokens in hand, so those two are gone and the three that remain here
 * run concurrently: 7 sequential gets → 5, of which these 3 are one round trip.
 *
 * `hasToken` keeps the OLD semantics exactly: `readAdminTokens` maps a missing
 * key to `undefined` but passes an empty string through, so an empty stored
 * token still counts as "not set" (`serviceTokenFromKv` already folds empty to
 * `undefined` itself). SECURITY: the token VALUES stop here — only the two
 * booleans reach a block (a title states the FACT that a token is set, never
 * any part of the token; the whole-response no-echo pins cover this).
 */
async function readPageState(ctx: PluginContext, tokens: AdminTokens): Promise<SettingsPageState> {
	const [displayName, tokenGen, serviceTokenGen, paymentSecrets, plainSettings] = await Promise.all(
		[
			// FAIL-SOFT alongside the rest (INC-C3): the display name is cosmetic, and
			// a kv blip on it must not deny the operator the secret forms below.
			ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY).catch(() => null),
			readSaveGen(ctx, INTERNAL_TOKEN_GEN_KEY),
			readSaveGen(ctx, SERVICE_TOKEN_GEN_KEY),
			readPaymentSecretState(ctx),
			readPlainSettings(ctx),
		],
	);
	return {
		plainSettings,
		displayName: displayName ?? "",
		hasToken: (tokens.adminToken ?? "").length > 0,
		hasServiceToken: tokens.serviceToken !== undefined,
		tokenGen,
		serviceTokenGen,
		paymentSecrets,
	};
}

/** The receipt for a token submit, which is NOT unconditionally "saved": the
 *  field is always blank on mount (INC-09) and a blank submit deliberately keeps
 *  the stored token, so the honest receipt for that path says nothing was
 *  entered. `which` is "Admin" or "Service" — the token's own name, so the
 *  banner names the same thing its form's submit button does. */
function tokenNotice(which: "Admin" | "Service", entered: boolean): Notice {
	const token = `${which.toLowerCase()} token`;
	return entered
		? {
				variant: "default",
				title: `${which} token saved`,
				description: `The ${token} was updated. It is stored write-only and never displayed.`,
			}
		: {
				variant: "default",
				title: `Nothing entered — ${token} unchanged`,
				description: `The field was blank, so the stored ${token} was kept. Enter a value to replace it.`,
			};
}

/** The receipt for a payment-secret submit — the same honest split as
 *  {@link tokenNotice}: a blank submit persists nothing and must not claim it
 *  did. Names the credential, never any part of its value. */
function secretNotice(spec: SecretFieldSpec, entered: boolean): Notice {
	return entered
		? {
				variant: "default",
				title: `${spec.noun} saved`,
				description: `The ${spec.noun.toLowerCase()} was updated. It is stored write-only and never displayed.`,
			}
		: {
				variant: "default",
				title: `Nothing entered — ${spec.noun.toLowerCase()} unchanged`,
				description: `The field was blank, so the stored ${spec.noun.toLowerCase()} was kept. Enter a value to replace it.`,
			};
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
	"save-token",
	"save-service-token",
	// INC-C3: the four payment/email secrets, from the one table that also builds
	// their forms — so a new secret is routable the moment it is declared.
	...PAYMENT_SECRET_FIELDS.map((spec) => spec.actionId),
	// INC-C5: their non-secret companions, saved as one form.
	SAVE_PAYMENT_SETTINGS_ACTION,
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
		description: "Cosmetic label for the admin reporting widget (stored in plugin kv).",
		tier: "kv",
	},
	holdTtlMinutes: {
		type: "number",
		label: "Cart hold TTL (minutes)",
		description: "Operational — how long a checkout hold survives (service DB).",
		tier: "service",
	},
	lowStockThreshold: {
		type: "number",
		label: "Low-stock threshold",
		description: "Operational — default threshold for the low-stock report (service DB).",
		tier: "service",
	},
};

const DISPLAY_NAME_MAX = 200;

export interface SettingsFormInput {
	/** em-dash BlockInteraction discriminant: `"page_load"` | `"block_action"` |
	 *  `"form_submit"`. Present on a real host interaction; absent → treated as a
	 *  page load. */
	type?: unknown;
	/** "save-display" (kv), "save-operational" (service), "save-token" (secret
	 *  kv), "save-service-token" (secret kv), or a page load. */
	action_id?: unknown;
	values?: Record<string, unknown>;
	/** Idempotency key for the privileged PUT (defaulted if absent). */
	idempotencyKey?: unknown;
}

export function createSettingsFormHandler(): RouteHandler<SettingsFormInput> {
	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		const action = typeof input.action_id === "string" ? input.action_id : "load";
		// BOTH tokens, from the one place every guarded admin screen sources them:
		//  - adminToken (X-Internal-Token) — `GET /settings` is admin surface too,
		//    not just the PUT (ADR-0010), so the READ needs it as well. Sourcing
		//    only the service token here is what left the Settings page unable to
		//    read once the GET was gated.
		//  - serviceToken (X-Service-Token, ADR-0007) — the machine write gate,
		//    needed by the non-GET PUT when the service secret is set.
		// MUTABLE on purpose: a successful token save below updates the copy the
		// re-render's collapsed "Service connection" title is computed from, so a
		// first-ever save cannot report the token it just persisted as "not set".
		// Re-reading kv would say the same thing at the cost of another get.
		let tokens = await readAdminTokens(ctx);
		// THE COMPOSITION ROOT, not a constructor (work order 02, INC-B10c-ii):
		// this screen no longer knows which transport serves it. The tokens READ
		// ABOVE are handed in so the http branch does not read write-only kv a
		// second time — `readAdminTokens` runs exactly ONCE per request, which is
		// the bug class every page cutover in this sub-effort has had to re-check.
		// On the in-process branch the tokens are ignored entirely (ADR-0014 D3):
		// there is no service to authenticate to.
		const { reporting: client } = await makeAdminClients(ctx, tokens);

		// -- kv save path: display name, S-5/S-5a ------------------------------
		if (action === "save-display") {
			const raw = input.values?.storeDisplayName;
			const name = typeof raw === "string" ? raw.trim() : "";
			if (name.length === 0 || name.length > DISPLAY_NAME_MAX) {
				// BUG FIX: this branch used to return `[header, banner]` — two
				// blocks, no form — so a merchant who typed a 201-char name was
				// stranded with no field to correct it. Re-render the full page.
				return renderPage(ctx, client, tokens, {
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
			const page = await renderPage(ctx, client, tokens, {
				variant: "default",
				title: "Display name saved",
				description: `Store display name saved: ${name}.`,
			});
			return {
				...page,
				toast: { message: "Display name saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- secret save path: admin token, WRITE-ONLY to ctx.kv --------------------
		if (action === "save-token") {
			// Mirror webhook-notifier (`plugin.ts:515`): persist ONLY when a
			// non-empty value was submitted, so a blank submit (the plain field
			// renders empty every time — INC-09 dropped the masked variant) never
			// clobbers an existing token.
			const raw = input.values?.internalToken;
			const entered = typeof raw === "string" && raw !== "";
			if (entered) {
				await ctx.kv.set(INTERNAL_TOKEN_KEY, raw);
				// Post-save clear (INC-09): bump the carrier `gen` so the re-rendered
				// field remounts blank instead of continuing to show what was typed.
				await bumpSaveGen(ctx, INTERNAL_TOKEN_GEN_KEY);
				// INC-15: the re-render's "Service connection" title must report the
				// token this branch just set, not the state kv held on entry.
				tokens = { ...tokens, adminToken: raw };
			}
			// INC-15: a blank submit persists NOTHING, so it must not claim it did.
			// The old receipt said "Admin token saved" on every path — and now that
			// the group's own label states whether a token is set, a blank submit on
			// an unprovisioned store rendered "Admin token saved" directly above
			// "Service connection — token not set". The receipt names the no-op.
			const page = await renderPage(ctx, client, tokens, tokenNotice("Admin", entered));
			return {
				...page,
				toast: {
					message: entered ? "Admin token saved" : "Admin token unchanged",
					type: entered ? "success" : "info",
				},
			} satisfies BlockResponse;
		}

		// -- secret save path: SERVICE token, WRITE-ONLY to ctx.kv ------------------
		if (action === "save-service-token") {
			// Same write-only discipline as the admin token: persist ONLY on a
			// non-empty submit so a blank submit (the plain field always renders
			// empty) never clobbers an existing token. NEVER rendered back.
			const raw = input.values?.serviceToken;
			const entered = typeof raw === "string" && raw !== "";
			if (entered) {
				await ctx.kv.set(SERVICE_TOKEN_KEY, raw);
				// Post-save clear (INC-09): bump the carrier `gen` so the re-rendered
				// field remounts blank instead of continuing to show what was typed.
				await bumpSaveGen(ctx, SERVICE_TOKEN_GEN_KEY);
				// INC-15: same reason as the admin token above.
				tokens = { ...tokens, serviceToken: raw };
			}
			// INC-15: the same honest no-op receipt as the admin token above.
			const page = await renderPage(ctx, client, tokens, tokenNotice("Service", entered));
			return {
				...page,
				toast: {
					message: entered ? "Service token saved" : "Service token unchanged",
					type: entered ? "success" : "info",
				},
			} satisfies BlockResponse;
		}

		// -- secret save path: payment/email secrets, WRITE-ONLY to ctx.kv ----------
		// INC-C3. Identical discipline to the two connection tokens above, driven
		// off PAYMENT_SECRET_FIELDS so every secret behaves the same way by
		// construction rather than by four copies agreeing: persist ONLY on a
		// non-empty submit (a blank submit keeps what is stored), bump the save
		// generation so the mount-only field remounts blank, and NEVER put the
		// value in a block, a label, a notice or a toast. `raw` is not captured by
		// anything that survives this block.
		const secretSpec = PAYMENT_SECRET_FIELDS.find((spec) => spec.actionId === action);
		if (secretSpec !== undefined) {
			const raw = input.values?.[secretSpec.fieldId];
			const entered = typeof raw === "string" && raw !== "";
			if (entered) {
				await ctx.kv.set(secretSpec.kvKey, raw);
				await bumpSaveGen(ctx, secretSpec.genKey);
			}
			const page = await renderPage(ctx, client, tokens, secretNotice(secretSpec, entered));
			return {
				...page,
				toast: {
					message: `${secretSpec.noun} ${entered ? "saved" : "unchanged"}`,
					type: entered ? "success" : "info",
				},
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
			const submitted = new Map(
				PLAIN_PAYMENT_SETTINGS.map((spec) => {
					const raw = input.values?.[spec.fieldId];
					return [spec.kvKey, typeof raw === "string" ? raw.trim() : ""] as const;
				}),
			);
			const payTo = submitted.get(X402_PAYTO_KEY) ?? "";
			if (payTo.length > 0 && !isPlausiblePayTo(payTo)) {
				// Names the FIELD and the SHAPE, never the rejected value — the value
				// is an address, not a secret, but echoing rejected input back into a
				// banner is how a screen grows an injection surface it never needed.
				return renderPage(ctx, client, tokens, {
					variant: "error",
					title: "Payment settings not saved",
					description:
						"The x402 destination wallet is not a wallet address (expected 0x followed by 40 hex characters, optionally CAIP-10 prefixed). Nothing was saved.",
				});
			}
			for (const [key, value] of submitted) await ctx.kv.set(key, value);
			const page = await renderPage(ctx, client, tokens, {
				variant: "default",
				title: "Payment settings saved",
				description: "Email from-address and x402 destination were updated.",
			});
			return {
				...page,
				toast: { message: "Payment settings saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- service save path: operational settings via PUT /settings --------------
		if (action === "save-operational") {
			const patch = extractOperationalPatch(input.values ?? {});
			const key =
				typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
					? input.idempotencyKey
					: `settings-${Date.now()}`;
			// NO per-call token: the client was built from this request's tokens at
			// the top of the handler, so the write authenticates exactly as the reads
			// do — and on the in-process tier there is nothing to authenticate.
			const result = await client.updateSettings(patch, { idempotencyKey: key });
			// This branch writes no token and no display name, so the state read at
			// the top of the handler is still current (INC-15).
			const state = await readPageState(ctx, tokens);
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
				// Surface the service's validation error INLINE (never a generic
				// "save failed" that hides the real reason). Re-render the ATTEMPTED
				// value for edited fields over the STORED value for un-edited ones (J6)
				// — never zero an un-edited field.
				let stored: OperationalSettingsWire | undefined;
				try {
					stored = await client.getSettings();
				} catch {
					stored = undefined;
				}
				const shown: OperationalSettingsWire = {
					holdTtlMinutes: patch.holdTtlMinutes ?? stored?.holdTtlMinutes ?? 0,
					lowStockThreshold: patch.lowStockThreshold ?? stored?.lowStockThreshold ?? 0,
				};
				return {
					blocks: buildSettingsBlocks({
						...state,
						settings: shown,
						// INC-15: the LABEL is the one place on this screen that reads as
						// PERSISTED state — a closed group saying "45 min hold" claims the
						// service holds 45. On a REJECTED save it does not: the form keeps
						// the attempted value so the operator can correct it (J6), and the
						// label keeps stating what is actually stored. When the stored
						// re-read failed there is nothing to state, and the label says
						// "not loaded" rather than inventing a zero.
						persisted: stored,
						notice: {
							variant: "error",
							title: superseded ? "Settings changed by someone else" : "Settings not saved",
							description: superseded
								? `${result.message} Nothing was saved.`
								: `Could not save settings: ${result.message}`,
						},
					}),
					toast: {
						message: superseded ? "Settings changed by someone else" : "Settings not saved",
						type: "error",
					},
				} satisfies BlockResponse;
			}
			return {
				blocks: buildSettingsBlocks({
					...state,
					settings: result.settings,
					// An ACCEPTED save: what is shown and what is stored are the same
					// thing, so the label states the values that just persisted.
					persisted: result.settings,
					notice: {
						variant: "default",
						title: "Settings saved",
						description: "Operational settings were updated.",
					},
				}),
				toast: { message: "Settings saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- page load: render current values (kv + GET /settings) ------------------
		return renderPage(ctx, client, tokens);
	};
}

/**
 * Render the full Settings page from kv + `GET /settings` — a GUARDED read
 * since ADR-0010. Always the FULL three-accordion screen (S-5): the caller
 * supplies an optional `notice` for the top banner (an action's outcome); a
 * bare page load passes none.
 *
 * E-1 / director ruling: `GET /settings` feeds ONLY the "Checkout & holds"
 * group — a SECONDARY read on a screen with no single primary collection (§4.1
 * has no list/detail "primary data block" concept to fail closed on). Its
 * failure therefore degrades to a `context` line inside that one group,
 * never a screen-wide fail-closed banner: the display name and both token
 * forms need no service read at all, and must keep working (no bootstrap
 * lockout). An earlier draft rendered a top-level `error` banner here, which
 * §12.6's listing implied — that is the N-1 defect this fixes; E-1's
 * primary/secondary split is the rule, and it wins.
 */
async function renderPage(
	ctx: PluginContext,
	client: ReportingSettingsSurface,
	tokens: AdminTokens,
	notice?: Notice,
): Promise<BlockResponse> {
	const state = await readPageState(ctx, tokens);
	try {
		// Nothing was attempted on this path, so what the form shows and what the
		// label states are the same read (see `persisted` in `buildSettingsBlocks`).
		const settings = await client.getSettings();
		return { blocks: buildSettingsBlocks({ ...state, settings, persisted: settings, notice }) };
	} catch {
		return {
			blocks: buildSettingsBlocks({ ...state, settings: undefined, persisted: undefined, notice }),
		};
	}
}

/** Non-money integer fields (minutes, thresholds) route through `text_input`
 *  with ONE parsing discipline (F-6): digits only, no sign, no decimal point.
 *  Accepts a raw `number` too — defensive only, since the real host's
 *  `text_input` always submits a string; a value that fails the pattern is
 *  OMITTED from the patch (never coerced to `NaN` or silently zeroed), so an
 *  un-parseable submission leaves that field untouched rather than corrupting
 *  it — the same "never zero an un-edited field" discipline as J6. */
const DIGITS_ONLY = /^\d+$/;

function parseDigitsField(raw: unknown): number | undefined {
	const text =
		typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : undefined;
	if (text === undefined || !DIGITS_ONLY.test(text)) return undefined;
	return Number(text);
}

function extractOperationalPatch(
	values: Record<string, unknown>,
): Partial<OperationalSettingsWire> {
	const patch: Partial<OperationalSettingsWire> = {};
	const holdTtlMinutes = parseDigitsField(values.holdTtlMinutes);
	if (holdTtlMinutes !== undefined) patch.holdTtlMinutes = holdTtlMinutes;
	const lowStockThreshold = parseDigitsField(values.lowStockThreshold);
	if (lowStockThreshold !== undefined) patch.lowStockThreshold = lowStockThreshold;
	return patch;
}

/**
 * §4.1 / §12.6 skeleton: header, page context, an optional notice banner, then
 * exactly three named groups — "Store", "Checkout & holds", "Service
 * connection" — each an `accordion`.
 *
 * INC-15 amends S-3 for THIS screen: all three groups now render
 * `default_open: false`, and each group's LABEL carries its own current values
 * ("Checkout & holds — 15 min hold · low stock at 5"), so a closed group still
 * answers the question the operator opened the screen to ask. The screen used
 * to open "Store" — the ONE cosmetic field on it — pushing the two groups that
 * hold operational and connection state below an expanded form. With the values
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
 * value redisplays correctly (the forms are mount-only `text_input` — INC-09
 * dropped the one `secret_input` this screen used to render — and once inside
 * an accordion each is that container's own index-0 child forever — nothing
 * else remounts them).
 */
function buildSettingsBlocks(args: {
	displayName: string;
	/** What the "Checkout & holds" FORM prefills from — on a rejected save this
	 *  carries the ATTEMPTED values over the stored ones (J6), so the operator can
	 *  correct what they typed. */
	settings: OperationalSettingsWire | undefined;
	/** What the "Checkout & holds" LABEL states: only values the service actually
	 *  holds, `undefined` when that is unknown. A collapsed label reads as
	 *  persisted state — it is the one thing on this screen that does — so it must
	 *  never state a value that was rejected. */
	persisted: OperationalSettingsWire | undefined;
	hasToken: boolean;
	hasServiceToken: boolean;
	tokenGen: number;
	serviceTokenGen: number;
	paymentSecrets: Map<string, SecretRenderState>;
	plainSettings: Map<string, string>;
	notice?: Notice;
}): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Settings" },
		{
			type: "context",
			text: "Display name is cosmetic; the rest is operational and lives in the service.",
		},
	];
	if (args.notice !== undefined) blocks.push(noticeBanner(args.notice));
	blocks.push(
		storeGroup(args.displayName),
		checkoutGroup(args.settings, args.persisted),
		connectionGroup({
			hasToken: args.hasToken,
			hasServiceToken: args.hasServiceToken,
			tokenGen: args.tokenGen,
			serviceTokenGen: args.serviceTokenGen,
		}),
		paymentsGroup(args.paymentSecrets, args.plainSettings),
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

/** The write-only admin-token form (INC-09: no masked variant). A plain
 *  `text_input` — no `secret_input`, no `has_value`, no reveal/copy control —
 *  that carries NO `initial_value` (the stored token is never rendered), so
 *  the field renders EMPTY on every FRESH mount, whether or not a token is
 *  already set; the placeholder alone carries the "blank keeps current"
 *  behaviour, which is unconditionally true (there is nothing to reveal
 *  either way).
 *
 *  POST-SAVE CLEAR: because the field itself never varies, `carriedForm`'s
 *  own prefill digest is now CONSTANT, so `gen` — this token's save
 *  generation, bumped by {@link bumpSaveGen} on every successful non-empty
 *  submit — rides in the carrier CONTEXT instead. That still changes the
 *  form's `block_id` on a real save, forcing the mount-only field to remount
 *  blank rather than keep showing what the operator just typed. Symmetric
 *  with {@link serviceTokenForm}. */
function tokenForm(gen: number): FormBlock {
	return carriedForm({
		namespace: "settings:admin-token",
		context: { gen: String(gen) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "internalToken",
					label: "Admin token (X-Internal-Token)",
					placeholder: "Enter new admin token (blank keeps current)",
				},
			],
			submit: { label: "Save admin token", action_id: "save-token" },
		},
	});
}

/** The write-only SERVICE-token form (ADR-0007) — the machine write-gate token
 *  the service enforces as `X-Service-Token`. Same plain, write-only
 *  discipline as {@link tokenForm} (INC-09), including the `gen`-carried
 *  post-save clear: no masked variant, no `initial_value`, a blank submit
 *  keeps the current token, and a successful save remounts the field blank.
 *  NEVER rendered back. */
function serviceTokenForm(gen: number): FormBlock {
	return carriedForm({
		namespace: "settings:service-token",
		context: { gen: String(gen) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "serviceToken",
					label: "Service token (X-Service-Token)",
					placeholder: "Enter new service token (blank keeps current)",
				},
			],
			submit: { label: "Save service token", action_id: "save-service-token" },
		},
	});
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

/** Whether each token is set, closed — the provisioning question this group
 *  exists to answer, and the reason the two booleans are threaded this far.
 *
 *  SECURITY: "token set" is a FACT ABOUT the credential, not any part of it.
 *  Neither token value is in scope here — only booleans — so there is nothing
 *  to echo, which is what keeps the whole-response no-echo pins green.
 *
 *  Deliberately "token set", not "admin token set": both-unset is the longest
 *  render at 58 characters, and the extra word would push it past X-11's
 *  60-char accordion-label budget. The group is already named "Service
 *  connection" and the forms inside are labelled in full. */
function connectionGroupLabel(hasToken: boolean, hasServiceToken: boolean): string {
	return valueLabel("Service connection", [
		hasToken ? "token set" : "token not set",
		hasServiceToken ? "service token set" : "service token not set",
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

function checkoutGroup(
	settings: OperationalSettingsWire | undefined,
	persisted: OperationalSettingsWire | undefined,
): AccordionBlock {
	const body: Block[] =
		settings === undefined
			? [
					// E-1 secondary-read failure: a context line, never a banner, and
					// never a fail-closed whole screen (see `renderPage`'s doc comment).
					{
						type: "context",
						text: "Operational settings could not be loaded right now. Store display name and connection tokens are unaffected — check the service connection and the admin token below.",
					},
				]
			: [
					{
						type: "context",
						text: "These persist in the commerce service and affect live checkout.",
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
									initial_value: String(settings.holdTtlMinutes),
								},
								{
									type: "text_input",
									action_id: "lowStockThreshold",
									label: SETTINGS_SCHEMA.lowStockThreshold.label,
									initial_value: String(settings.lowStockThreshold),
								},
							],
							submit: { label: "Save operational settings", action_id: "save-operational" },
						},
					}),
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
 * credentials that used to be `wrangler secret put` entries on the commerce
 * service (`packages/service/wrangler.jsonc`). With the service folded in there
 * is no second deployable to hold them, so this screen is where they land.
 *
 * Every field is a PLAIN, ALWAYS-EMPTY `text_input` — the INC-09 discipline the
 * two connection tokens already follow: no `secret_input`, no `initial_value`,
 * no `has_value`, so a SET secret renders identically to an unset one and there
 * is nothing on the screen to reveal. The placeholder alone carries "blank keeps
 * current", which is unconditionally true.
 */
function paymentsGroup(
	state: Map<string, SecretRenderState>,
	plain: Map<string, string>,
): AccordionBlock {
	return {
		type: "accordion",
		block_id: "settings:payments",
		label: paymentsGroupLabel(state),
		default_open: false,
		blocks: [
			{
				type: "context",
				text: "Payment and email credentials, stored write-only — a blank submit keeps the current one. None is ever displayed.",
			},
			...PAYMENT_SECRET_FIELDS.map((spec) => secretForm(spec, state.get(spec.kvKey)?.gen ?? 0)),
			// INC-C5: the non-secret companions, LAST so the group still reads
			// credentials-first, and visibly a different kind of field — these
			// prefill with what is stored.
			{
				type: "context",
				text: "These are configuration, not credentials, so they are shown back to you. The x402 destination wallet is where buyers' payments go — x402 checkout stays unavailable until it is set.",
			},
			plainSettingsForm(plain),
		],
	};
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

/** Which payment credentials are provisioned, readable with the group closed —
 *  the only question this group answers from state.
 *
 *  SECURITY: "set"/"not set" is a FACT ABOUT a credential, not any part of it.
 *  No secret VALUE is in scope in this function or its caller, so there is
 *  nothing here to echo. The label lists only what is MISSING (or says
 *  "configured"), which is the actionable half and keeps the longest render
 *  inside X-11's 60-character budget via {@link valueLabel}. */
function paymentsGroupLabel(state: Map<string, SecretRenderState>): string {
	const missing = PAYMENT_SECRET_FIELDS.filter((spec) => state.get(spec.kvKey)?.set !== true).map(
		(spec) => spec.short,
	);
	return valueLabel(
		"Payments & email",
		missing.length === 0 ? ["configured"] : [`no ${missing.join(", ")}`],
	);
}

/** One write-only secret field. Same shape as {@link serviceTokenForm},
 *  including the `gen`-carried post-save clear: because the field never varies,
 *  `carriedForm`'s own prefill digest is constant, so the save generation rides
 *  in the carrier CONTEXT to change the form's `block_id` on a real save and
 *  force the mount-only input to remount blank. */
function secretForm(spec: SecretFieldSpec, gen: number): FormBlock {
	return carriedForm({
		namespace: `settings:${spec.actionId}`,
		context: { gen: String(gen) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: spec.fieldId,
					label: spec.label,
					placeholder: `Enter new ${spec.noun.toLowerCase()} (blank keeps current)`,
				},
			],
			submit: { label: `Save ${spec.noun.toLowerCase()}`, action_id: spec.actionId },
		},
	});
}

function connectionGroup(args: {
	hasToken: boolean;
	hasServiceToken: boolean;
	tokenGen: number;
	serviceTokenGen: number;
}): AccordionBlock {
	return {
		type: "accordion",
		block_id: "settings:connection",
		label: connectionGroupLabel(args.hasToken, args.hasServiceToken),
		default_open: false,
		blocks: [
			{
				type: "context",
				text: "Both tokens are stored write-only — a blank submit keeps the current one. Neither is ever displayed.",
			},
			tokenForm(args.tokenGen),
			serviceTokenForm(args.serviceTokenGen),
		],
	};
}
