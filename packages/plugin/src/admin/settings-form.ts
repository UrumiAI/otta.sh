import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type { Block, BlockResponse, RouteHandler, SettingsFieldSpec } from "../types.js";
import { type OperationalSettingsWire, ReportingSettingsClient } from "./reporting-client.js";

/**
 * The admin Settings form (plan §5.3 / §6 Step 7) — ONE form, TWO save paths
 * made visible, not hidden:
 *  - `storeDisplayName` (kv tier) saves via `ctx.kv.set` with NO service call.
 *  - `holdTtlMinutes` / `lowStockThreshold` (service tier) save via
 *    `PUT /settings` over `ctx.http`, surfacing the service's `400` validation
 *    error INLINE (never swallowed).
 *
 * SECURITY (§5): the kv-backed field is display-only; no secret is ever read
 * from or written to `ctx.kv` here, and the admin token used for the privileged
 * `PUT` arrives as transient route INPUT (the cookie-blind bearer-as-input
 * pattern) — never persisted to kv, never in a rendered block.
 */
export const SETTINGS_ROUTE = "admin/settings";

/** The kv key for the cosmetic store display name (`settings:*` = the em-dash
 *  convention for user-configurable prefs shown in admin UI). */
export const STORE_DISPLAY_NAME_KEY = "settings:storeDisplayName";

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
	/** "save-display" (kv), "save-operational" (service), or a page load. */
	action_id?: unknown;
	values?: Record<string, unknown>;
	/** Idempotency key for the privileged PUT (defaulted if absent). */
	idempotencyKey?: unknown;
	/** Admin token forwarded to the service for the privileged PUT (route input,
	 *  never persisted). */
	adminToken?: unknown;
}

export function createSettingsFormHandler(): RouteHandler<SettingsFormInput> {
	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		const action = typeof input.action_id === "string" ? input.action_id : "load";
		const client = new ReportingSettingsClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
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

		// -- service save path: operational settings via PUT /settings --------------
		if (action === "save-operational") {
			const patch = extractOperationalPatch(input.values ?? {});
			const key =
				typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
					? input.idempotencyKey
					: `settings-${Date.now()}`;
			const adminToken = typeof input.adminToken === "string" ? input.adminToken : undefined;
			const result = await client.updateSettings(patch, { idempotencyKey: key, adminToken });
			if (!result.ok) {
				// Surface the service's validation error INLINE (never a generic
				// "save failed" that hides the real reason). Re-render the ATTEMPTED
				// value for edited fields over the STORED value for un-edited ones (J6)
				// — never zero an un-edited field.
				const displayName = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? "";
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
						...formBlocks(displayName, shown),
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
			return {
				blocks: formBlocks(displayName, result.settings),
				toast: { message: "Settings saved", type: "success" },
			} satisfies BlockResponse;
		}

		// -- page load: render current values (kv + GET /settings) ------------------
		const displayName = (await ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY)) ?? "";
		try {
			const settings = await client.getSettings();
			return { blocks: formBlocks(displayName, settings) } satisfies BlockResponse;
		} catch (err) {
			// Fail closed: render the kv field + an error banner, never throw.
			const message = err instanceof Error ? err.message : String(err);
			return {
				blocks: [
					{ type: "header", text: "Settings" },
					{ type: "section", text: `Store display name: ${displayName || "(unset)"}` },
					{
						type: "banner",
						variant: "error",
						text: `Operational settings unavailable: ${message}`,
					},
				],
				toast: { message: "Could not load operational settings", type: "error" },
			} satisfies BlockResponse;
		}
	};
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

function formBlocks(displayName: string, settings: OperationalSettingsWire): Block[] {
	return [
		{ type: "header", text: "Settings" },
		{
			type: "context",
			text: "Display name is stored in plugin kv (cosmetic). Operational settings persist in the service DB.",
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
	];
}
