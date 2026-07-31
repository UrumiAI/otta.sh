import { COMMERCE_SERVICE_BASE_URL, SERVICE_TOKEN_KEY, serviceTokenFromKv } from "../manifest.js";
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
import { type OperationalSettingsWire, ReportingSettingsClient } from "./reporting-client.js";
import { carriedForm, noticeBanner, readAdminTokens, type Notice } from "./scaffold/index.js";

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

/** Current save generation for a token key, defaulting to 0 when never saved. */
async function readSaveGen(ctx: PluginContext, key: string): Promise<number> {
	return (await ctx.kv.get<number>(key)) ?? 0;
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
		const { adminToken, serviceToken } = await readAdminTokens(ctx);
		const client = new ReportingSettingsClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(adminToken !== undefined ? { adminToken } : {}),
			...(serviceToken !== undefined ? { serviceToken } : {}),
		});

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

		// -- secret save path: admin token, WRITE-ONLY to ctx.kv --------------------
		if (action === "save-token") {
			// Mirror webhook-notifier (`plugin.ts:515`): persist ONLY when a
			// non-empty value was submitted, so a blank submit (the plain field
			// renders empty every time — INC-09 dropped the masked variant) never
			// clobbers an existing token.
			const raw = input.values?.internalToken;
			if (typeof raw === "string" && raw !== "") {
				await ctx.kv.set(INTERNAL_TOKEN_KEY, raw);
				// Post-save clear (INC-09): bump the carrier `gen` so the re-rendered
				// field remounts blank instead of continuing to show what was typed.
				await bumpSaveGen(ctx, INTERNAL_TOKEN_GEN_KEY);
			}
			const page = await renderPage(ctx, client, {
				variant: "default",
				title: "Admin token saved",
				description: "The admin token was updated. It is stored write-only and never displayed.",
			});
			return {
				...page,
				toast: { message: "Admin token saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- secret save path: SERVICE token, WRITE-ONLY to ctx.kv ------------------
		if (action === "save-service-token") {
			// Same write-only discipline as the admin token: persist ONLY on a
			// non-empty submit so a blank submit (the plain field always renders
			// empty) never clobbers an existing token. NEVER rendered back.
			const raw = input.values?.serviceToken;
			if (typeof raw === "string" && raw !== "") {
				await ctx.kv.set(SERVICE_TOKEN_KEY, raw);
				// Post-save clear (INC-09): bump the carrier `gen` so the re-rendered
				// field remounts blank instead of continuing to show what was typed.
				await bumpSaveGen(ctx, SERVICE_TOKEN_GEN_KEY);
			}
			const page = await renderPage(ctx, client, {
				variant: "default",
				title: "Service token saved",
				description: "The service token was updated. It is stored write-only and never displayed.",
			});
			return {
				...page,
				toast: { message: "Service token saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- service save path: operational settings via PUT /settings --------------
		if (action === "save-operational") {
			const patch = extractOperationalPatch(input.values ?? {});
			const key =
				typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
					? input.idempotencyKey
					: `settings-${Date.now()}`;
			// The privileged PUT's token is the SAME write-only-kv admin token read
			// above (em-dash's page_load/form_submit carries NO token) — one read,
			// no chance of the read and the write disagreeing.
			const result = await client.updateSettings(patch, { idempotencyKey: key, adminToken });
			const displayName = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? "";
			const hasToken = ((await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? "").length > 0;
			const hasServiceToken = serviceToken !== undefined;
			const tokenGen = await readSaveGen(ctx, INTERNAL_TOKEN_GEN_KEY);
			const serviceTokenGen = await readSaveGen(ctx, SERVICE_TOKEN_GEN_KEY);
			if (!result.ok) {
				// Surface the service's validation error INLINE (never a generic
				// "save failed" that hides the real reason). Re-render the ATTEMPTED
				// value for edited fields over the STORED value for un-edited ones (J6)
				// — never zero an un-edited field.
				let stored: OperationalSettingsWire;
				try {
					stored = await client.getSettings();
				} catch {
					stored = { holdTtlMinutes: 0, lowStockThreshold: 0 };
				}
				const shown: OperationalSettingsWire = {
					holdTtlMinutes: patch.holdTtlMinutes ?? stored.holdTtlMinutes,
					lowStockThreshold: patch.lowStockThreshold ?? stored.lowStockThreshold,
				};
				return {
					blocks: buildSettingsBlocks({
						displayName,
						settings: shown,
						hasToken,
						hasServiceToken,
						tokenGen,
						serviceTokenGen,
						notice: {
							variant: "error",
							title: "Settings not saved",
							description: `Could not save settings: ${result.message}`,
						},
					}),
					toast: { message: "Settings not saved", type: "error" },
				} satisfies BlockResponse;
			}
			return {
				blocks: buildSettingsBlocks({
					displayName,
					settings: result.settings,
					hasToken,
					hasServiceToken,
					tokenGen,
					serviceTokenGen,
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
	client: ReportingSettingsClient,
	notice?: Notice,
): Promise<BlockResponse> {
	const displayName = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? "";
	const hasToken = ((await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? "").length > 0;
	const hasServiceToken = (await serviceTokenFromKv(ctx)) !== undefined;
	const tokenGen = await readSaveGen(ctx, INTERNAL_TOKEN_GEN_KEY);
	const serviceTokenGen = await readSaveGen(ctx, SERVICE_TOKEN_GEN_KEY);
	try {
		const settings = await client.getSettings();
		return {
			blocks: buildSettingsBlocks({
				displayName,
				settings,
				hasToken,
				hasServiceToken,
				tokenGen,
				serviceTokenGen,
				notice,
			}),
		};
	} catch {
		return {
			blocks: buildSettingsBlocks({
				displayName,
				settings: undefined,
				hasToken,
				hasServiceToken,
				tokenGen,
				serviceTokenGen,
				notice,
			}),
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
 * connection" — each an `accordion`. S-3: exactly one is `default_open: true`
 * ("Store"), named explicitly, always — there is no per-record state to
 * derive it from on this screen. S-4: every prefilling form's `block_id`
 * comes from `carriedForm` so a saved value redisplays correctly (the forms
 * are mount-only `text_input` — INC-09 dropped the one `secret_input` this
 * screen used to render — and once inside an accordion each is that
 * container's own index-0 child forever — nothing else remounts them).
 */
function buildSettingsBlocks(args: {
	displayName: string;
	settings: OperationalSettingsWire | undefined;
	hasToken: boolean;
	hasServiceToken: boolean;
	tokenGen: number;
	serviceTokenGen: number;
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
	// args.hasToken / args.hasServiceToken are read but not consumed below —
	// KEEP them: INC-15 needs exactly these two booleans for the "Service
	// connection" accordion's collapsed title ("token set · service token not
	// set"), so this is deliberate future plumbing, not dead code.
	blocks.push(
		storeGroup(args.displayName),
		checkoutGroup(args.settings),
		connectionGroup({ tokenGen: args.tokenGen, serviceTokenGen: args.serviceTokenGen }),
	);
	return blocks;
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

function storeGroup(displayName: string): AccordionBlock {
	return {
		type: "accordion",
		block_id: "settings:store",
		label: "Store",
		default_open: true, // S-3: the one open group on this screen, always
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

function checkoutGroup(settings: OperationalSettingsWire | undefined): AccordionBlock {
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
		label: "Checkout & holds",
		default_open: false,
		blocks: body,
	};
}

function connectionGroup(args: { tokenGen: number; serviceTokenGen: number }): AccordionBlock {
	return {
		type: "accordion",
		block_id: "settings:connection",
		label: "Service connection",
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
