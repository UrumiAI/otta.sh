import { EMAIL_FROM_KEY } from "../email/ctx-http-email-sender.js";
import { isPlausiblePayTo, X402_ACCEPTS_KEY, X402_PAYTO_KEY } from "../payments/x402-wiring.js";
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
import { makeAdminClients } from "./make-admin-clients.js";
import type { OperationalSettingsWire, ReportingSettingsSurface } from "./reporting-client.js";
import { carriedForm, noticeBanner, type Notice } from "./scaffold/index.js";

/**
 * The admin Settings screen (§4.1 report/settings skeleton;
 * `docs/admin/ADMIN-CONSOLE.md` §12.6) — ONE page, TWO named groups, TWO save
 * paths made visible, not hidden:
 *  - `storeDisplayName` (kv tier, "Store" group) saves via `ctx.kv.set`.
 *  - `holdTtlMinutes` / `lowStockThreshold` (service tier, "Checkout & holds"
 *    group) save via `PUT /settings` over `ctx.http`, surfacing the service's
 *    `400` validation error INLINE (never swallowed).
 *
 * RETIRED (work order 02, INC-D3a): this screen used to carry a third
 * "Service connection" group with two more write-only secret forms —
 * `internalToken` (`X-Internal-Token`, the token the guarded `/reports/*`
 * reads and the privileged `PUT /settings` needed) and `serviceToken`
 * (`X-Service-Token`, ADR-0007's machine write-gate the service enforced on
 * every non-GET). Both existed to authenticate THIS plugin to
 * `@otta-sh/service` as a separate deployable. Now that the commerce service
 * is folded into the plugin (ADR-0014/0015) there is nothing left on the
 * other side of that call to authenticate to, so both tokens, their kv keys,
 * their save-generation counters, and the group that held their forms are
 * gone outright rather than kept as dead provisioning UI. The INC-09
 * write-only, never-masked discipline they pioneered survives below in
 * {@link paymentsGroup} — the credentials that still need it.
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
		kvKey: X402_FACILITATOR_API_KEY_KEY,
		genKey: "settings:x402FacilitatorApiKeyGen",
		// INC-C5 renamed the FIELD, the kv key AND the generation key, because the
		// meaning changed: in-process the value is the bearer credential the
		// facilitator call SENDS, not the offline HMAC secret INC-C3's label
		// described. An operator who provisioned under the old label holds a
		// forge-a-settlement secret this increment would hand to a third-party
		// host, so the old value must not be inherited — the new key names make
		// the field read as unset until it is deliberately re-provisioned (review
		// round 2, A5). `short` is unchanged, so the group label stays exactly
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
 * The kv half of a render.
 *
 * INC-D3a: this used to also take the two connection tokens the handler had
 * read at the top of the request, folded in so the (now-deleted) "Service
 * connection" group's booleans could be derived from them rather than re-read
 * (that was INC-15's whole point: two of what used to be 7 sequential kv gets
 * were redundant re-reads). With both tokens gone — the commerce service they
 * authenticated to is gone — there is nothing left to derive from a
 * caller-supplied argument, so this reads everything itself: the display name,
 * the payment-secret state, and the plain payment settings, three concurrent
 * gets.
 */
async function readPageState(ctx: PluginContext): Promise<SettingsPageState> {
	const [displayName, paymentSecrets, plainSettings] = await Promise.all([
		// FAIL-SOFT alongside the rest (INC-C3): the display name is cosmetic, and
		// a kv blip on it must not deny the operator the secret forms below.
		ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY).catch(() => null),
		readPaymentSecretState(ctx),
		readPlainSettings(ctx),
	]);
	return {
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
	/** "save-display" (kv), "save-operational" (service), one of the
	 *  payment/email secret action ids (secret kv), "save-payment-settings"
	 *  (kv), or a page load. */
	action_id?: unknown;
	values?: Record<string, unknown>;
	/** Idempotency key for the privileged PUT (defaulted if absent). */
	idempotencyKey?: unknown;
}

export function createSettingsFormHandler(): RouteHandler<SettingsFormInput> {
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
			const entered = typeof raw === "string" && raw !== "";
			if (entered) {
				await ctx.kv.set(secretSpec.kvKey, raw);
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
			const payTo = submitted.get(X402_PAYTO_KEY) ?? "";
			if (payTo.length > 0 && !isPlausiblePayTo(payTo)) {
				// Names the FIELD and the SHAPE, never the rejected value — the value
				// is an address, not a secret, but echoing rejected input back into a
				// banner is how a screen grows an injection surface it never needed.
				return renderPage(ctx, client, {
					variant: "error",
					title: "Payment settings not saved",
					description:
						"The x402 destination wallet is not a wallet address (expected 0x followed by 40 hex characters, optionally CAIP-10 prefixed). Nothing was saved.",
				});
			}
			for (const [key, value] of submitted) await ctx.kv.set(key, value);
			const page = await renderPage(ctx, client, {
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
			// There is nothing to authenticate any more (INC-D3a): `updateSettings`
			// runs in-process against this plugin's own store, not a separate
			// service call that would need a token attached.
			const result = await client.updateSettings(patch, { idempotencyKey: key });
			// This branch writes no display name, so a fresh read here is current.
			const state = await readPageState(ctx);
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
		return renderPage(ctx, client);
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
	notice?: Notice,
): Promise<BlockResponse> {
	const state = await readPageState(ctx);
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
						text: "Operational settings could not be loaded right now. Store display name and payment/email settings are unaffected.",
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
 * Every field is a PLAIN, ALWAYS-EMPTY `text_input` — the INC-09 discipline
 * this screen's two now-retired connection tokens introduced (see the module
 * doc comment): no `secret_input`, no `initial_value`, no `has_value`, so a
 * SET secret renders identically to an unset one and there is nothing on the
 * screen to reveal. The placeholder alone carries "blank keeps current",
 * which is unconditionally true.
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

/** One write-only secret field, with a `gen`-carried post-save clear: because
 *  the field never varies, `carriedForm`'s own prefill digest is constant, so
 *  the save generation rides in the carrier CONTEXT to change the form's
 *  `block_id` on a real save and force the mount-only input to remount
 *  blank. */
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
