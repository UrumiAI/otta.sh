/**
 * The plugin entrypoint (standard format): EmDash wraps this default export with
 * `adaptSandboxEntry`, so it runs in `plugins: []` and stays sandbox-portable.
 * Type-only imports: nothing from `emdash` is bundled.
 */
import type { EmailDeliverEvent, PluginContext, SandboxedPlugin } from "emdash/plugin";

/** KV keys of the admin settings form (`settingsSchema` in ./index.ts). */
const ENDPOINT = "settings:endpoint";
const API_KEY = "settings:apiKey";
const FROM = "settings:from";

/** The slice of PluginContext the handler uses; a full PluginContext satisfies it. */
export interface DeliverContext {
	kv: Pick<PluginContext["kv"], "get">;
	http?: PluginContext["http"];
}

async function requireSetting(ctx: DeliverContext, key: string): Promise<string> {
	const value = await ctx.kv.get<unknown>(key);
	if (typeof value !== "string" || value === "") {
		throw new Error(`email provider: "${key}" is not set; fill in the plugin's settings`);
	}
	return value;
}

/** The `email:deliver` handler. Throwing = failed send; otta retries it later. */
export async function deliver(event: EmailDeliverEvent, ctx: DeliverContext): Promise<void> {
	if (!ctx.http) throw new Error('email provider: missing the "network:request" capability');
	const endpoint = await requireSetting(ctx, ENDPOINT);
	const apiKey = await requireSetting(ctx, API_KEY);
	const from = await requireSetting(ctx, FROM);
	const { to, subject, text, html } = event.message;

	// ctx.http.fetch is the host's fetch, limited to the descriptor's allowedHosts.
	const response = await ctx.http.fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ from, to, subject, text, ...(html === undefined ? {} : { html }) }),
	});
	if (!response.ok) {
		// Status and host only. Never the key, and never the response body, which may echo the request.
		throw new Error(`email provider: HTTP ${response.status} from ${new URL(endpoint).host}`);
	}
}

export default {
	hooks: {
		// `exclusive: true` is what makes this a selectable provider in Settings → Email.
		"email:deliver": { exclusive: true, handler: deliver },
	},
} satisfies SandboxedPlugin;
