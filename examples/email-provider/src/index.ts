/**
 * The descriptor your site's EmDash config registers: `plugins: [httpEmailProvider(...)]`.
 * See docs/email-providers.md.
 */
import type { PluginDescriptor } from "emdash";

export interface HttpEmailProviderOptions {
	/** Hostname of your email API, e.g. "api.mail.example.net". The endpoint setting must use it. */
	apiHost: string;
}

export function httpEmailProvider({ apiHost }: HttpEmailProviderOptions): PluginDescriptor {
	return {
		id: "http-email",
		version: "0.0.0",
		format: "standard",
		// The module that default-exports ./plugin.ts. Rename to your package.
		entrypoint: "@otta-sh/example-email-provider/plugin",
		capabilities: ["hooks.email-transport:register", "network:request"],
		allowedHosts: [apiHost],
		settingsSchema: {
			endpoint: { type: "url", label: "API endpoint", description: `https://${apiHost}/...` },
			apiKey: { type: "secret", label: "API key" },
			from: { type: "email", label: "From address", description: "Verified with your email API" },
		},
	};
}
