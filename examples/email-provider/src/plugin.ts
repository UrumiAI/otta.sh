/**
 * The plugin entrypoint (standard format): EmDash wraps this default export with
 * `adaptSandboxEntry`, so it runs in `plugins: []` and stays sandbox-portable.
 * Type-only imports: nothing from `emdash` is bundled.
 */
import type { EmailDeliverEvent, PluginContext, SandboxedPlugin } from "emdash/plugin";

/**
 * Your email API's endpoint. It is code, not an admin setting, so nobody with
 * settings access can redirect the key elsewhere. Must be https; ./index.ts
 * derives `allowedHosts` from it.
 */
export const EMAIL_API_URL = "https://api.mail.example.net/v1/send";

/** KV keys of the admin settings form (`settingsSchema` in ./index.ts). */
const API_KEY = "settings:apiKey";
const FROM = "settings:from";
/** Printable ASCII, no spaces: anything else could end up echoed in a fetch header error. */
const SAFE_KEY = /^[\x21-\x7E]+$/;

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
	const http = ctx.http;
	if (!http) throw new Error('email provider: missing the "network:request" capability');
	const [apiKey, from] = await Promise.all([
		requireSetting(ctx, API_KEY),
		requireSetting(ctx, FROM),
	]);
	// Name the setting, never the value.
	if (!SAFE_KEY.test(apiKey))
		throw new Error(`email provider: "${API_KEY}" has invalid characters`);
	const { to, subject, text, html } = event.message;
	const host = new URL(EMAIL_API_URL).host;

	let response: Response;
	try {
		// ctx.http.fetch is the host's fetch, limited to allowedHosts. Pass no AbortSignal:
		// it cannot cross the sandbox boundary.
		response = await http.fetch(EMAIL_API_URL, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ from, to, subject, text, html }),
		});
	} catch (error) {
		// oxlint-disable-next-line preserve-caught-error -- a fetch error can quote the request's headers (the key)
		throw new Error(
			`email provider: request to ${host} failed (${error instanceof Error ? error.name : "unknown"})`,
		);
	}
	if (!response.ok) {
		await response.body?.cancel();
		// Status and host only. Never the key, and never the body, which may echo the request.
		throw new Error(`email provider: HTTP ${response.status} from ${host}`);
	}
}

export default {
	hooks: {
		// `exclusive: true` is what makes this a selectable provider in Settings → Email.
		"email:deliver": { exclusive: true, handler: deliver },
	},
} satisfies SandboxedPlugin;
