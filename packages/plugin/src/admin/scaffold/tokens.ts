import { serviceTokenFromKv } from "../../manifest.js";
import type { PluginContext } from "../../types.js";
import { INTERNAL_TOKEN_KEY } from "../settings-form.js";

/**
 * The two tokens every guarded admin screen threads onto its `ctx.http` client,
 * sourced identically for all screens (the pattern `settings-form.ts` set):
 *   - `adminToken` — the route auth token (`X-Internal-Token`), persisted
 *     write-only to `ctx.kv` under `settings:internalToken`; forwarded on every
 *     guarded read/write.
 *   - `serviceToken` — the machine write-gate token (`X-Service-Token`, ADR-0007),
 *     also write-only in `ctx.kv`; attached to NON-GET writes so the gate lets
 *     them through when the service secret is set.
 *
 * Both are OPTIONAL: undefined ⇒ no header ⇒ byte-identical to a deployment
 * with the secret unset. This is the ONE place a new screen sources its tokens,
 * so the threading never drifts between screens.
 */
export interface AdminTokens {
	adminToken?: string;
	serviceToken?: string;
}

export async function readAdminTokens(ctx: PluginContext): Promise<AdminTokens> {
	const adminToken = (await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? undefined;
	const serviceToken = await serviceTokenFromKv(ctx);
	return {
		...(adminToken !== undefined ? { adminToken } : {}),
		...(serviceToken !== undefined ? { serviceToken } : {}),
	};
}
