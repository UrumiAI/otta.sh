import { COMMERCE_SERVICE_BASE_URL, SERVICE_TOKEN_KEY, serviceTokenFromKv } from "../manifest.js";
import type {
	AdminPageConfig,
	Block,
	BlockResponse,
	FormBlock,
	PluginContext,
	RouteHandler,
	SettingsFieldSpec,
} from "../types.js";
import { type OperationalSettingsWire, ReportingSettingsClient } from "./reporting-client.js";
import { readAdminTokens } from "./scaffold/tokens.js";

/**
 * The admin Settings form (plan §5.3 / §6 Step 7, extended by ADR-0007) — ONE
 * page, FOUR save paths made visible, not hidden:
 *  - `storeDisplayName` (kv tier) saves via `ctx.kv.set` with NO service call.
 *  - `holdTtlMinutes` / `lowStockThreshold` (service tier) save via
 *    `PUT /settings` over `ctx.http`, surfacing the service's `400` validation
 *    error INLINE (never swallowed).
 *  - `internalToken` (secret tier) — the admin token the guarded `/reports/*`
 *    reads and the privileged `PUT /settings` need. Persisted WRITE-ONLY to
 *    `ctx.kv` under `settings:internalToken` (the em-dash webhook-notifier
 *    `secret_input` pattern) and NEVER rendered back into a block.
 *  - `serviceToken` (secret tier, ADR-0007) — the machine write-gate token the
 *    service enforces as `X-Service-Token` on every non-GET. Persisted
 *    WRITE-ONLY to `ctx.kv` under `settings:serviceToken`, same discipline as
 *    the admin token; read at runtime by every plugin client (storefront +
 *    admin) via `serviceTokenFromKv`. This is the provisioning surface deploy
 *    ordering depends on (provision here BEFORE flipping the service secret).
 *
 * SECURITY (§5): the display name is cosmetic. The admin token AND the service
 * token are shared secrets that live in em-dash's plugin-settings kv (bounded by
 * em-dash admin/DB security, the same trade-off webhook-notifier accepts). Both
 * are masked, treated write-only (only overwritten on a non-empty submit), and
 * have no read-back path into any block, toast, or error text. NOTE the service
 * token is MORE sensitive than the admin token — it unlocks the entire write
 * surface, not just `/admin` + `/internal`.
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
	 *  kv), or a page load. */
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

		// -- kv save path: display name, NO ctx.http --------------------------------
		if (action === "save-display") {
			const raw = input.values?.storeDisplayName;
			const name = typeof raw === "string" ? raw.trim() : "";
			if (name.length === 0 || name.length > DISPLAY_NAME_MAX) {
				return {
					blocks: [
						{ type: "header", text: "Settings" },
						{
							type: "banner",
							variant: "error",
							text: `Store display name must be 1–${DISPLAY_NAME_MAX} characters.`,
						},
					],
					toast: { message: "Invalid display name", type: "error" },
				} satisfies BlockResponse;
			}
			await ctx.kv.set(STORE_DISPLAY_NAME_KEY, name);
			// Re-render from kv ONLY (no service round-trip) so this path provably
			// never touches ctx.http.
			const saved = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? name;
			return {
				blocks: [
					{ type: "header", text: "Settings" },
					{ type: "section", text: `Store display name saved: ${saved}` },
				],
				toast: { message: "Display name saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- secret save path: admin token, WRITE-ONLY to ctx.kv --------------------
		if (action === "save-token") {
			// Mirror webhook-notifier (`plugin.ts:515`): persist ONLY when a
			// non-empty value was submitted, so a blank submit (the masked field
			// renders empty every time) never clobbers an existing token.
			const raw = input.values?.internalToken;
			if (typeof raw === "string" && raw !== "") {
				await ctx.kv.set(INTERNAL_TOKEN_KEY, raw);
			}
			// Re-render the page (never echoing the secret) with a success toast.
			const page = await renderPage(ctx, client);
			return {
				...page,
				toast: { message: "Admin token saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- secret save path: SERVICE token, WRITE-ONLY to ctx.kv ------------------
		if (action === "save-service-token") {
			// Same write-only discipline as the admin token: persist ONLY on a
			// non-empty submit so a blank submit (the masked field always renders
			// empty) never clobbers an existing token. NEVER rendered back.
			const raw = input.values?.serviceToken;
			if (typeof raw === "string" && raw !== "") {
				await ctx.kv.set(SERVICE_TOKEN_KEY, raw);
			}
			const page = await renderPage(ctx, client);
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
			if (!result.ok) {
				// Surface the service's validation error INLINE (never a generic
				// "save failed" that hides the real reason). Re-render the ATTEMPTED
				// value for edited fields over the STORED value for un-edited ones (J6)
				// — never zero an un-edited field.
				const displayName = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? "";
				const hasToken = ((await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? "").length > 0;
				const hasServiceToken = serviceToken !== undefined;
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
					blocks: [
						...formBlocks(displayName, shown, hasToken, hasServiceToken),
						{
							type: "banner",
							variant: "error",
							text: `Could not save settings: ${result.message}`,
						},
					],
					toast: { message: "Settings not saved", type: "error" },
				} satisfies BlockResponse;
			}
			const displayName = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? "";
			const hasToken = ((await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? "").length > 0;
			const hasServiceToken = serviceToken !== undefined;
			return {
				blocks: formBlocks(displayName, result.settings, hasToken, hasServiceToken),
				toast: { message: "Settings saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- page load: render current values (kv + GET /settings) ------------------
		return renderPage(ctx, client) satisfies Promise<BlockResponse>;
	};
}

/** Render the full Settings page from kv + `GET /settings` — a GUARDED read
 *  since ADR-0010, so `client` must already carry the admin token. Fails CLOSED
 *  on any service error (including a 401/503 from that guard) with a GENERIC
 *  banner — never leaks a raw HTTP status/URL, and never renders the stored
 *  secret. The fail-closed render still shows BOTH token forms, so an admin
 *  whose token is missing can still provision one (no bootstrap lockout). */
async function renderPage(
	ctx: PluginContext,
	client: ReportingSettingsClient,
): Promise<BlockResponse> {
	const displayName = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? "";
	const hasToken = ((await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? "").length > 0;
	const hasServiceToken = (await serviceTokenFromKv(ctx)) !== undefined;
	try {
		const settings = await client.getSettings();
		return { blocks: formBlocks(displayName, settings, hasToken, hasServiceToken) };
	} catch {
		// Fail closed: render the kv field + both token forms + a GENERIC error banner.
		return {
			blocks: [
				{ type: "header", text: "Settings" },
				{ type: "section", text: `Store display name: ${displayName || "(unset)"}` },
				tokenForm(hasToken),
				serviceTokenForm(hasServiceToken),
				{
					type: "banner",
					variant: "error",
					text: "Operational settings are unavailable — check the commerce service connection and the admin/service tokens.",
				},
			],
			toast: { message: "Could not load operational settings", type: "error" },
		};
	}
}

function extractOperationalPatch(
	values: Record<string, unknown>,
): Partial<OperationalSettingsWire> {
	const patch: Partial<OperationalSettingsWire> = {};
	if (values.holdTtlMinutes !== undefined && values.holdTtlMinutes !== null) {
		patch.holdTtlMinutes = Number(values.holdTtlMinutes);
	}
	if (values.lowStockThreshold !== undefined && values.lowStockThreshold !== null) {
		patch.lowStockThreshold = Number(values.lowStockThreshold);
	}
	return patch;
}

function formBlocks(
	displayName: string,
	settings: OperationalSettingsWire,
	hasToken: boolean,
	hasServiceToken: boolean,
): Block[] {
	return [
		{ type: "header", text: "Settings" },
		{
			type: "context",
			text: "Display name is stored in plugin kv (cosmetic). Operational settings persist in the service DB. The admin token and service token are stored write-only in plugin kv.",
		},
		{
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
		{
			type: "form",
			fields: [
				{
					type: "number_input",
					action_id: "holdTtlMinutes",
					label: SETTINGS_SCHEMA.holdTtlMinutes.label,
					initial_value: settings.holdTtlMinutes,
				},
				{
					type: "number_input",
					action_id: "lowStockThreshold",
					label: SETTINGS_SCHEMA.lowStockThreshold.label,
					initial_value: settings.lowStockThreshold,
				},
			],
			submit: { label: "Save operational settings", action_id: "save-operational" },
		},
		tokenForm(hasToken),
		serviceTokenForm(hasServiceToken),
	];
}

/** The write-only admin-token form. The `secret_input` element carries NO
 *  `initial_value` (the stored token is never rendered); `has_value` signals a
 *  token is already set and the placeholder tells the admin a blank submit
 *  keeps it. */
function tokenForm(hasToken: boolean): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "secret_input",
				action_id: "internalToken",
				label: "Admin token (X-Internal-Token)",
				placeholder: hasToken ? "Leave blank to keep current token" : "Enter admin token",
				has_value: hasToken,
			},
		],
		submit: { label: "Save admin token", action_id: "save-token" },
	};
}

/** The write-only SERVICE-token form (ADR-0007) — the machine write-gate token
 *  the service enforces as `X-Service-Token`. Same masked, write-only discipline
 *  as the admin token: no `initial_value`, `has_value` signals it is set, and a
 *  blank submit keeps the current token. NEVER rendered back. */
function serviceTokenForm(hasServiceToken: boolean): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "secret_input",
				action_id: "serviceToken",
				label: "Service token (X-Service-Token)",
				placeholder: hasServiceToken ? "Leave blank to keep current token" : "Enter service token",
				has_value: hasServiceToken,
			},
		],
		submit: { label: "Save service token", action_id: "save-service-token" },
	};
}
